/* ============================================================
   CARTO GUIDAGE — app.js
   Application de mesures terrain avec import Excel, carte
   Leaflet/OSM, itinéraires calibrés en durée (Google Directions),
   suivi de statut par point, sauvegarde JSON locale.
   ============================================================ */

(function () {
  "use strict";

  // ---------------------------------------------------------
  // ÉTAT GLOBAL
  // ---------------------------------------------------------
  const STORAGE_KEY = "cg_state_v1";

  /** @type {{
   *   points: Array<{id:string, name:string, lat:number, lng:number, pairId:string, pairIndex:number, status:'pending'|'validated', validatedAt:?string, route:?object}>,
   *   pairs: Array<{id:string, pointIds:string[]}>,
   *   settings: {durMin:number, durMax:number, apiKey:string},
   *   rawImport: {headers:string[], rows:object[]} | null
   * }}
   */
  let state = {
    points: [],
    pairs: [],
    settings: { durMin: 15, durMax: 20, apiKey: "" },
    rawImport: null
  };

  let map, userMarker, userAccuracyCircle;
  const pointLayers = new Map(); // pointId -> L.Marker
  const routeLayers = new Map(); // pairId -> L.Polyline
  let watchId = null;
  let activePointId = null;

  // ---------------------------------------------------------
  // ZONES REGLEMENTAIRES (ZTD / AZD / ZND) — multi-villes
  // ---------------------------------------------------------
  const ZONE_TYPES = {
    ztd: { color: "#0E8F7E", label: "ZTD" },
    azd: { color: "#E85D3D", label: "AZD" },
    znd: { color: "#2563EB", label: "ZND" }
  };
  const CITY_LABELS = { paris: "Paris", bethune: "Béthune", nantes: "Nantes", "douai-lens": "Douai-Lens", angers: "Angers", pau: "Pau", toulouse: "Toulouse" };
  let currentZoneCity = "paris";
  const zoneLayers = {}; // "city:type" -> L.GeoJSON
  const zoneDataCache = {}; // "city:type" -> geojson deja charge

  // ---------------------------------------------------------
  // PERSISTANCE LOCALE
  // ---------------------------------------------------------
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Sauvegarde locale impossible", e);
      showToast("Sauvegarde locale impossible (stockage plein ?)");
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = Object.assign(state, parsed);
      }
    } catch (e) {
      console.error("Lecture sauvegarde locale impossible", e);
    }
  }

  function exportStateToFile() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `carto-guidage_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Fichier de sauvegarde téléchargé");
  }

  function importStateFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed || !Array.isArray(parsed.points)) {
          throw new Error("Format invalide");
        }
        state = Object.assign(
          { points: [], pairs: [], settings: { durMin: 15, durMax: 20, apiKey: "" }, rawImport: null },
          parsed
        );
        saveState();
        applySettingsToUI();
        rebuildMapFromState();
        renderPointsList();
        showToast("Tournée restaurée depuis le fichier");
      } catch (err) {
        console.error(err);
        showToast("Fichier de sauvegarde illisible");
      }
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------
  // UTILITAIRES UI
  // ---------------------------------------------------------
  function showToast(message, duration = 2600) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, duration);
  }

  function setStatusText(text) {
    document.getElementById("status-text").textContent = text;
  }

  function uid(prefix) {
    return prefix + "_" + Math.random().toString(36).slice(2, 10);
  }

  // ---------------------------------------------------------
  // PANNEAU LATÉRAL
  // ---------------------------------------------------------
  function openPanel() {
    document.getElementById("side-panel").classList.add("open");
    document.getElementById("panel-backdrop").hidden = false;
  }
  function closePanel() {
    document.getElementById("side-panel").classList.remove("open");
    document.getElementById("panel-backdrop").hidden = true;
  }

  // ---------------------------------------------------------
  // TIROIR LISTE DES POINTS
  // ---------------------------------------------------------
  function toggleDrawer() {
    document.getElementById("points-drawer").classList.toggle("expanded");
  }

  function renderPointsList() {
    const list = document.getElementById("points-list");
    const title = document.getElementById("drawer-title");
    title.textContent = `Points de la tournée (${state.points.length})`;

    if (state.points.length === 0) {
      list.innerHTML = `<div class="empty-state">Aucun point importé pour le moment.<br>Ouvrez le menu pour importer un fichier Excel.</div>`;
      return;
    }

    list.innerHTML = "";
    state.pairs.forEach((pair, pairIdx) => {
      pair.pointIds.forEach((pid, idxInPair) => {
        const pt = state.points.find((p) => p.id === pid);
        if (!pt) return;
        const row = document.createElement("div");
        row.className = "point-row";
        row.innerHTML = `
          <span class="point-dot ${pt.status === "validated" ? "validated" : ""}"></span>
          <span class="point-row-text">
            <div class="point-row-name">${escapeHtml(pt.name)}</div>
            <div class="point-row-meta">Paire ${pairIdx + 1} · Point ${idxInPair + 1}${pt.status === "validated" ? " · Validé" : ""}</div>
          </span>
          <span class="point-row-chevron">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        `;
        row.addEventListener("click", () => focusPoint(pt.id));
        list.appendChild(row);
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ---------------------------------------------------------
  // IMPORT EXCEL
  // ---------------------------------------------------------
  function handleExcelFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[firstSheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        if (!rows.length) {
          showImportSummary("Le fichier ne contient aucune ligne exploitable.", "error");
          return;
        }

        const headers = Object.keys(rows[0]);
        state.rawImport = { headers, rows };
        populateColumnMapping(headers);
        showImportSummary(`${rows.length} ligne(s) détectée(s) dans "${firstSheetName}". Choisissez les colonnes ci-dessous.`, "ok");
        document.getElementById("column-mapping").hidden = false;
      } catch (err) {
        console.error(err);
        showImportSummary("Impossible de lire ce fichier Excel.", "error");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function showImportSummary(text, kind) {
    const el = document.getElementById("import-summary");
    el.textContent = text;
    el.className = "import-summary " + (kind || "");
  }

  function populateColumnMapping(headers) {
    const selName = document.getElementById("col-name");
    const selLat = document.getElementById("col-lat");
    const selLng = document.getElementById("col-lng");
    [selName, selLat, selLng].forEach((sel) => (sel.innerHTML = ""));

    headers.forEach((h) => {
      [selName, selLat, selLng].forEach((sel) => {
        const opt = document.createElement("option");
        opt.value = h;
        opt.textContent = h;
        sel.appendChild(opt);
      });
    });

    // Pré-sélection heuristique si les noms de colonnes sont explicites
    guessColumn(selName, headers, ["nom", "name", "point", "site", "label"]);
    guessColumn(selLat, headers, ["lat", "latitude"]);
    guessColumn(selLng, headers, ["lon", "lng", "long", "longitude"]);
  }

  function guessColumn(selectEl, headers, keywords) {
    const found = headers.find((h) =>
      keywords.some((kw) => h.toLowerCase().includes(kw))
    );
    if (found) selectEl.value = found;
  }

  function applyColumnMapping() {
    if (!state.rawImport) return;
    const nameCol = document.getElementById("col-name").value;
    const latCol = document.getElementById("col-lat").value;
    const lngCol = document.getElementById("col-lng").value;

    const rows = state.rawImport.rows;
    const newPoints = [];
    let skipped = 0;

    rows.forEach((row) => {
      const lat = parseFloat(String(row[latCol]).replace(",", "."));
      const lng = parseFloat(String(row[lngCol]).replace(",", "."));
      const name = String(row[nameCol] ?? "").trim();
      if (!name || isNaN(lat) || isNaN(lng)) {
        skipped++;
        return;
      }
      newPoints.push({
        id: uid("pt"),
        name,
        lat,
        lng,
        pairId: "",
        pairIndex: 0,
        status: "pending",
        validatedAt: null,
        route: null
      });
    });

    if (newPoints.length < 2) {
      showImportSummary("Pas assez de points valides pour former des paires (2 points par paire).", "error");
      return;
    }

    // Regroupement séquentiel par paires de 2 points consécutifs
    const pairs = [];
    for (let i = 0; i < newPoints.length; i += 2) {
      const a = newPoints[i];
      const b = newPoints[i + 1];
      if (!b) break; // point isolé sans binôme, ignoré
      const pairId = uid("pair");
      a.pairId = pairId; a.pairIndex = 0;
      b.pairId = pairId; b.pairIndex = 1;
      pairs.push({ id: pairId, pointIds: [a.id, b.id] });
    }

    state.points = newPoints.slice(0, pairs.length * 2);
    state.pairs = pairs;
    saveState();
    rebuildMapFromState();
    renderPointsList();
    document.getElementById("column-mapping").hidden = true;
    showImportSummary(`${state.points.length} points importés en ${pairs.length} paire(s).`, "ok");
    setStatusText(`${pairs.length} paire(s) chargée(s) — ${state.points.filter(p=>p.status==='validated').length}/${state.points.length} points validés`);
    closePanel();

    // Calcule automatiquement les itinéraires si une clé API est renseignée
    if (state.settings.apiKey) {
      pairs.forEach((p) => computeRouteForPair(p.id));
    } else {
      showToast("Ajoutez votre clé API Google dans le menu pour calculer les trajets");
    }
  }

  // ---------------------------------------------------------
  // CARTE LEAFLET
  // ---------------------------------------------------------
  function initMap() {
    map = L.map("map", { zoomControl: false }).setView([46.6, 2.2], 6); // vue France par défaut
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
  }

  function markerIcon(status) {
    const cls = status === "validated" ? "validated" : "pending";
    return L.divIcon({
      className: "",
      html: `<div class="cg-marker ${cls}"><div class="cg-marker-label"></div></div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 24],
      popupAnchor: [0, -22]
    });
  }

  function rebuildMapFromState() {
    // Nettoyage
    pointLayers.forEach((m) => map.removeLayer(m));
    pointLayers.clear();
    routeLayers.forEach((l) => map.removeLayer(l));
    routeLayers.clear();

    const bounds = [];
    state.points.forEach((pt) => {
      const marker = L.marker([pt.lat, pt.lng], { icon: markerIcon(pt.status) }).addTo(map);
      marker.on("click", () => focusPoint(pt.id));
      pointLayers.set(pt.id, marker);
      bounds.push([pt.lat, pt.lng]);
    });

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [60, 60] });
    }

    // Redessine les itinéraires déjà calculés
    state.pairs.forEach((pair) => {
      const a = state.points.find((p) => p.id === pair.pointIds[0]);
      if (a && a.route && a.route.polyline) {
        drawRoutePolyline(pair.id, a.route.polyline);
      }
    });
  }

  function drawRoutePolyline(pairId, latlngs) {
    if (routeLayers.has(pairId)) {
      map.removeLayer(routeLayers.get(pairId));
    }
    const line = L.polyline(latlngs, { color: "#1B5E4F", weight: 4, opacity: 0.85 }).addTo(map);
    routeLayers.set(pairId, line);
  }

  function updateMarkerStatus(pointId) {
    const pt = state.points.find((p) => p.id === pointId);
    const marker = pointLayers.get(pointId);
    if (pt && marker) {
      marker.setIcon(markerIcon(pt.status));
    }
  }

  function focusPoint(pointId) {
    const pt = state.points.find((p) => p.id === pointId);
    if (!pt) return;
    activePointId = pointId;
    map.panTo([pt.lat, pt.lng]);
    openPointSheet(pt);
  }

  // ---------------------------------------------------------
  // ZONES REGLEMENTAIRES — chargement et affichage
  // ---------------------------------------------------------
  async function toggleZone(zoneKey, show) {
    const typeCfg = ZONE_TYPES[zoneKey];
    if (!typeCfg) return;
    const city = currentZoneCity;
    const cacheKey = `${city}:${zoneKey}`;
    const file = `zones/${city}_${zoneKey}.geojson`;

    if (show) {
      if (!zoneLayers[cacheKey]) {
        setStatusText(`Chargement de la zone ${typeCfg.label} (${CITY_LABELS[city]})...`);
        try {
          if (!zoneDataCache[cacheKey]) {
            const res = await fetch(file);
            if (!res.ok) throw new Error("Fichier introuvable");
            zoneDataCache[cacheKey] = await res.json();
          }
          const layer = L.geoJSON(zoneDataCache[cacheKey], {
            style: {
              color: typeCfg.color,
              weight: 1.8,
              opacity: 0.85,
              fillColor: typeCfg.color,
              fillOpacity: 0.12
            }
          });
          zoneLayers[cacheKey] = layer;
        } catch (err) {
          console.error(`Erreur de chargement de la zone ${typeCfg.label} (${city})`, err);
          showToast(`Impossible de charger la zone ${typeCfg.label} pour ${CITY_LABELS[city]}`);
          const checkbox = document.getElementById(`zone-toggle-${zoneKey}`);
          if (checkbox) checkbox.checked = false;
          setStatusText("");
          return;
        }
      }
      zoneLayers[cacheKey].addTo(map);
      setStatusText("");
    } else if (zoneLayers[cacheKey]) {
      map.removeLayer(zoneLayers[cacheKey]);
    }

    updateZoneLegend();
  }

  function updateZoneLegend() {
    const legend = document.getElementById("map-legend");
    const activeEntries = Object.keys(zoneLayers).filter(
      (k) => zoneLayers[k] && map.hasLayer(zoneLayers[k])
    );
    if (!activeEntries.length) {
      legend.hidden = true;
      legend.innerHTML = "";
      return;
    }
    legend.innerHTML = activeEntries
      .map((k) => {
        const [city, type] = k.split(":");
        const typeCfg = ZONE_TYPES[type];
        return `<div class="map-legend-item">
          <span class="zone-swatch" style="background:${typeCfg.color}33;border-color:${typeCfg.color}"></span>
          ${typeCfg.label} — ${CITY_LABELS[city]}
        </div>`;
      })
      .join("");
    legend.hidden = false;
  }

  function clearAllZoneLayers() {
    Object.keys(zoneLayers).forEach((k) => {
      if (zoneLayers[k] && map.hasLayer(zoneLayers[k])) {
        map.removeLayer(zoneLayers[k]);
      }
    });
    Object.keys(ZONE_TYPES).forEach((zoneKey) => {
      const checkbox = document.getElementById(`zone-toggle-${zoneKey}`);
      if (checkbox) checkbox.checked = false;
    });
    updateZoneLegend();
  }

  function bindZoneToggles() {
    Object.keys(ZONE_TYPES).forEach((zoneKey) => {
      const checkbox = document.getElementById(`zone-toggle-${zoneKey}`);
      if (!checkbox) return;
      checkbox.addEventListener("change", (e) => {
        toggleZone(zoneKey, e.target.checked);
      });
    });

    const citySelect = document.getElementById("zone-city-select");
    if (citySelect) {
      citySelect.addEventListener("change", (e) => {
        clearAllZoneLayers();
        currentZoneCity = e.target.value;
      });
    }
  }

  // ---------------------------------------------------------
  // GÉOLOCALISATION
  // ---------------------------------------------------------
  function startGeolocation() {
    if (!("geolocation" in navigator)) {
      showToast("Géolocalisation non disponible sur cet appareil");
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        if (!userMarker) {
          userMarker = L.circleMarker([latitude, longitude], {
            radius: 8,
            color: "#fff",
            weight: 2,
            fillColor: "#2563EB",
            fillOpacity: 1
          }).addTo(map);
          userAccuracyCircle = L.circle([latitude, longitude], {
            radius: accuracy,
            color: "#2563EB",
            weight: 1,
            fillOpacity: 0.08
          }).addTo(map);
        } else {
          userMarker.setLatLng([latitude, longitude]);
          userAccuracyCircle.setLatLng([latitude, longitude]);
          userAccuracyCircle.setRadius(accuracy);
        }
      },
      (err) => {
        console.warn("Géolocalisation refusée ou indisponible", err);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  // ---------------------------------------------------------
  // FICHE POINT (bottom sheet)
  // ---------------------------------------------------------
  function openPointSheet(pt) {
    const sheet = document.getElementById("point-sheet");
    const pair = state.pairs.find((p) => p.id === pt.pairId);
    const pairIdx = state.pairs.indexOf(pair);

    document.getElementById("sheet-pair-label").textContent =
      `Paire ${pairIdx + 1} · Point ${pt.pairIndex + 1} sur 2`;
    document.getElementById("sheet-point-name").textContent = pt.name;

    const routeInfo = document.getElementById("sheet-route-info");
    const other = pair ? state.points.find((p) => p.id !== pt.id && pair.pointIds.includes(p.id)) : null;
    if (pt.route) {
      const warn = (pt.route.durationMin < state.settings.durMin || pt.route.durationMin > state.settings.durMax);
      routeInfo.innerHTML = `
        Trajet vers <strong>${escapeHtml(other ? other.name : "point associé")}</strong><br>
        <span class="route-duration ${warn ? "warn" : ""}">${pt.route.durationMin} min</span> · ${pt.route.distanceKm} km
        ${warn ? "<br><span>⚠ Hors bornes 15–20 min, recalcul conseillé</span>" : ""}
      `;
    } else {
      routeInfo.textContent = other
        ? "Itinéraire non calculé (ajoutez votre clé API Google dans le menu)."
        : "Point isolé sans binôme.";
    }

    const statusBtn = document.getElementById("sheet-toggle-status");
    if (pt.status === "validated") {
      statusBtn.textContent = "Repasser en non validé";
      statusBtn.classList.add("is-validated");
    } else {
      statusBtn.textContent = "Marquer comme validé";
      statusBtn.classList.remove("is-validated");
    }

    sheet.hidden = false;
  }

  function closePointSheet() {
    document.getElementById("point-sheet").hidden = true;
    activePointId = null;
  }

  function toggleActivePointStatus() {
    const pt = state.points.find((p) => p.id === activePointId);
    if (!pt) return;
    pt.status = pt.status === "validated" ? "pending" : "validated";
    pt.validatedAt = pt.status === "validated" ? new Date().toISOString() : null;
    saveState();
    updateMarkerStatus(pt.id);
    renderPointsList();
    openPointSheet(pt); // rafraîchit la fiche
    setStatusText(`${state.pairs.length} paire(s) — ${state.points.filter(p=>p.status==='validated').length}/${state.points.length} points validés`);
    showToast(pt.status === "validated" ? "Point validé" : "Point repassé en attente");
  }

  function navigateToActivePoint() {
    const pt = state.points.find((p) => p.id === activePointId);
    if (!pt) return;
    const pair = state.pairs.find((p) => p.id === pt.pairId);
    const route = pt.route;

    let url;
    if (route && route.waypoints && route.waypoints.length) {
      // Intègre les waypoints calculés pour reproduire la durée calibrée
      const wp = route.waypoints.map((w) => `${w.lat},${w.lng}`).join("|");
      url = `https://www.google.com/maps/dir/?api=1&destination=${pt.lat},${pt.lng}&waypoints=${encodeURIComponent(wp)}&travelmode=driving`;
    } else {
      url = `https://www.google.com/maps/dir/?api=1&destination=${pt.lat},${pt.lng}&travelmode=driving`;
    }
    window.open(url, "_blank");
  }

  // ---------------------------------------------------------
  // CALCUL D'ITINÉRAIRE CALIBRÉ EN DURÉE (Google Directions)
  // ---------------------------------------------------------
  // NOTE : l'API Google Directions ne supporte pas nativement le CORS
  // pour les appels depuis un navigateur vers l'endpoint classique.
  // On utilise donc l'endpoint compatible ou, si besoin, un proxy.
  // Ici on tente l'appel direct (fonctionne via la lib JS officielle
  // chargée séparément si nécessaire) — voir README pour le détail.

  async function recalculateAllRoutes() {
    if (!state.settings.apiKey) {
      showToast("Ajoutez d'abord votre clé API Google dans le menu");
      return;
    }
    if (!state.pairs.length) {
      showToast("Aucune tournée importée pour le moment");
      return;
    }
    showToast(`Recalcul de ${state.pairs.length} itinéraire(s) en cours...`);
    for (const pair of state.pairs) {
      await computeRouteForPair(pair.id);
    }
    showToast("Recalcul des itinéraires terminé");
  }

  async function computeRouteForPair(pairId) {
    const pair = state.pairs.find((p) => p.id === pairId);
    if (!pair) return;
    const [aId, bId] = pair.pointIds;
    const a = state.points.find((p) => p.id === aId);
    const b = state.points.find((p) => p.id === bId);
    if (!a || !b) return;

    const apiKey = state.settings.apiKey;
    if (!apiKey) {
      showToast("Renseignez votre clé API Google dans le menu");
      return;
    }

    setStatusText(`Calcul de l'itinéraire pour "${a.name}" ↔ "${b.name}"...`);

    try {
      const direct = await fetchDirections(a, b, [], apiKey);
      let finalRoute = direct;

      const targetMin = state.settings.durMin;
      const targetMax = state.settings.durMax;

      if (direct.durationMin < targetMin) {
        finalRoute = await inflateRouteToTarget(a, b, direct, targetMin, targetMax, apiKey);
      } else if (direct.durationMin > targetMax) {
        showToast(`Trajet direct "${a.name}" ↔ "${b.name}" déjà > ${targetMax} min (${direct.durationMin} min). Conservé tel quel.`);
      }

      a.route = finalRoute;
      b.route = finalRoute;
      saveState();
      drawRoutePolyline(pairId, finalRoute.polyline);
      renderPointsList();
      setStatusText(`${state.pairs.length} paire(s) — ${state.points.filter(p=>p.status==='validated').length}/${state.points.length} points validés`);
      showToast(`Itinéraire "${a.name}" ↔ "${b.name}" : ${finalRoute.durationMin} min`);
    } catch (err) {
      console.error(err);
      showToast(`Erreur de calcul d'itinéraire : ${err.message || err}`);
      setStatusText("Erreur lors du calcul d'un itinéraire");
    }
  }

  /**
   * Appelle l'API Google Directions entre deux points, avec waypoints optionnels.
   * Retourne { durationMin, distanceKm, polyline: [[lat,lng],...], waypoints: [{lat,lng}] }
   */
  async function fetchDirections(origin, destination, waypoints, apiKey) {
    const originStr = `${origin.lat},${origin.lng}`;
    const destStr = `${destination.lat},${destination.lng}`;
    const wpParam = waypoints.length
      ? `&waypoints=${waypoints.map((w) => `${w.lat},${w.lng}`).join("|")}`
      : "";

    // Endpoint Directions classique (nécessite que la clé autorise les requêtes
    // depuis le domaine GitHub Pages ; sinon voir README pour l'option proxy).
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originStr}&destination=${destStr}${wpParam}&mode=driving&key=${apiKey}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "OK" || !data.routes || !data.routes.length) {
      throw new Error(data.error_message || data.status || "Réponse invalide de Google Directions");
    }

    const route = data.routes[0];
    let totalSeconds = 0;
    let totalMeters = 0;
    const path = [];

    route.legs.forEach((leg) => {
      totalSeconds += leg.duration.value;
      totalMeters += leg.distance.value;
    });

    // Décodage de la polyline globale pour affichage
    const decoded = decodePolyline(route.overview_polyline.points);

    return {
      durationMin: Math.round(totalSeconds / 60),
      distanceKm: Math.round(totalMeters / 100) / 10,
      polyline: decoded,
      waypoints: waypoints.slice()
    };
  }

  /**
   * Ajoute progressivement des waypoints de détour autour du segment direct
   * jusqu'à ce que la durée totale tombe dans la fourchette [targetMin, targetMax].
   * Stratégie : on génère des points de détour perpendiculaires au segment
   * direct, à distance croissante, et on teste l'itinéraire résultant.
   */
  async function inflateRouteToTarget(origin, destination, directRoute, targetMin, targetMax, apiKey) {
    const midLat = (origin.lat + destination.lat) / 2;
    const midLng = (origin.lng + destination.lng) / 2;

    // Vecteur perpendiculaire au segment direct (approximation plane, suffisante
    // à l'échelle d'un trajet routier local).
    const dLat = destination.lat - origin.lat;
    const dLng = destination.lng - origin.lng;
    const norm = Math.sqrt(dLat * dLat + dLng * dLng) || 1e-6;
    const perpLat = -dLng / norm;
    const perpLng = dLat / norm;

    // Distance de détour en degrés, augmentée progressivement.
    // ~0.01° ≈ 1.1 km ; on part petit et on amplifie.
    const stepDegrees = [0.01, 0.02, 0.035, 0.055, 0.08, 0.11, 0.15, 0.2];

    let best = directRoute;
    let bestDiff = distanceToRange(directRoute.durationMin, targetMin, targetMax);

    for (const offset of stepDegrees) {
      const detourPoint = {
        lat: midLat + perpLat * offset,
        lng: midLng + perpLng * offset
      };
      let candidate;
      try {
        candidate = await fetchDirections(origin, destination, [detourPoint], apiKey);
      } catch (e) {
        continue; // on ignore ce candidat et on essaie le suivant
      }

      const diff = distanceToRange(candidate.durationMin, targetMin, targetMax);

      if (candidate.durationMin >= targetMin && candidate.durationMin <= targetMax) {
        return candidate; // pile dans la fourchette, on s'arrête
      }
      if (diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
      if (candidate.durationMin > targetMax) {
        break; // on a dépassé la borne haute, inutile d'aller plus loin
      }
    }

    return best; // meilleur candidat trouvé, même hors bornes
  }

  function distanceToRange(value, min, max) {
    if (value < min) return min - value;
    if (value > max) return value - max;
    return 0;
  }

  /** Décodage standard d'une polyline encodée Google. */
  function decodePolyline(encoded) {
    let points = [];
    let index = 0, lat = 0, lng = 0;

    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;

      shift = 0; result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;

      points.push([lat / 1e5, lng / 1e5]);
    }
    return points;
  }

  // ---------------------------------------------------------
  // PARAMÈTRES
  // ---------------------------------------------------------
  function applySettingsToUI() {
    document.getElementById("dur-min").value = state.settings.durMin;
    document.getElementById("dur-max").value = state.settings.durMax;
    document.getElementById("google-api-key").value = state.settings.apiKey || "";
  }

  function bindSettingsInputs() {
    document.getElementById("dur-min").addEventListener("change", (e) => {
      state.settings.durMin = parseInt(e.target.value, 10) || 15;
      saveState();
    });
    document.getElementById("dur-max").addEventListener("change", (e) => {
      state.settings.durMax = parseInt(e.target.value, 10) || 20;
      saveState();
    });
    document.getElementById("google-api-key").addEventListener("change", (e) => {
      state.settings.apiKey = e.target.value.trim();
      saveState();
    });
  }

  // ---------------------------------------------------------
  // RÉINITIALISATION
  // ---------------------------------------------------------
  function resetTournee() {
    if (!confirm("Réinitialiser entièrement la tournée (points, itinéraires, statuts) ? Cette action est irréversible sur cet appareil.")) {
      return;
    }
    state.points = [];
    state.pairs = [];
    state.rawImport = null;
    saveState();
    rebuildMapFromState();
    renderPointsList();
    closePointSheet();
    setStatusText("Aucune tournée chargée");
    showToast("Tournée réinitialisée");
  }

  // ---------------------------------------------------------
  // INITIALISATION / ÉCOUTEURS
  // ---------------------------------------------------------
  function bindEvents() {
    document.getElementById("btn-menu").addEventListener("click", openPanel);
    document.getElementById("btn-close-panel").addEventListener("click", closePanel);
    document.getElementById("panel-backdrop").addEventListener("click", closePanel);

    document.getElementById("excel-input").addEventListener("change", (e) => {
      if (e.target.files[0]) handleExcelFile(e.target.files[0]);
    });
    document.getElementById("btn-apply-mapping").addEventListener("click", applyColumnMapping);

    document.getElementById("btn-export").addEventListener("click", exportStateToFile);
    document.getElementById("json-input").addEventListener("change", (e) => {
      if (e.target.files[0]) importStateFromFile(e.target.files[0]);
    });
    document.getElementById("btn-reset").addEventListener("click", resetTournee);
    document.getElementById("btn-recalculate-routes").addEventListener("click", recalculateAllRoutes);

    document.getElementById("drawer-handle").addEventListener("click", toggleDrawer);

    document.getElementById("sheet-close").addEventListener("click", closePointSheet);
    document.getElementById("sheet-toggle-status").addEventListener("click", toggleActivePointStatus);
    document.getElementById("sheet-navigate").addEventListener("click", navigateToActivePoint);

    bindSettingsInputs();
    bindZoneToggles();
  }

  function init() {
    loadState();
    initMap();
    startGeolocation();
    bindEvents();
    applySettingsToUI();
    rebuildMapFromState();
    renderPointsList();

    if (state.pairs.length) {
      setStatusText(`${state.pairs.length} paire(s) — ${state.points.filter(p=>p.status==='validated').length}/${state.points.length} points validés`);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
