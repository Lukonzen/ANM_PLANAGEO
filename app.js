(() => {
  "use strict";

  const ANM_QUERY = "https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0/query";
  const SGB_QUERY = "https://geoportal.sgb.gov.br/server/rest/services/Hosted/Aerogeofisica/FeatureServer/1/query";
  const ANM_FIELDS = "PROCESSO,NUMERO,ANO,FASE,NOME,SUBS,USO,AREA_HA,UF,ULT_EVENTO,ID,OBJECTID,DSProcesso";
  const SGB_FIELDS = "objectid,num_projeto,projeto,metodo,ano_prev,processo_sei,direcao_lv,espacamento_lv,espacamento_lc,km_estimado,custo_estimado,area,objetivo,objeto_geologico,bioma,tempo_estimado,observacao,status,bloco";

  // Séries do Banco de Dados Aero (arquivos locais do repositório)
  const SERIES = [
    { key: "serie1000", label: "Série 1000", file: "./Serie_1000.geojson", color: "#65a30d", outline: "#4d7c0f" },
    { key: "serie3000", label: "Série 3000", file: "./Serie_3000.geojson", color: "#db2777", outline: "#9d174d" }
  ];

  // Grupos de métodos do Planageo (atributo "metodo"), classificados por palavra-chave
  const METHOD_COLORS = { em: "#2563eb", gama: "#0d9488", grad: "#7c3aed", other: "#64748b" };

  const $ = (id) => document.getElementById(id);
  const statusEl = $("searchStatus");
  const resultsEl = $("results");
  const summaryEl = $("resultsSummary");
  const detailsEl = $("projectDetails");
  const projectSummaryEl = $("projectSummary");
  const searchButton = $("searchButton");

  let planageoFeatures = [];
  let selectedResultButton = null;
  let activeTitleFeature = null;
  const seriesData = {}; // key -> { features: [...], bboxes: [...] }
  let seriesLoadInfo = "";

  const map = new maplibregl.Map({
    container: "map",
    center: [-52, -14],
    zoom: 3.4,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    }
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }));

  function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", isError);
  }

  const EMPTY_FC = () => ({ type: "FeatureCollection", features: [] });

  /* ---------------------------------------------------------------
   * Classificação dos métodos do Planageo
   * ------------------------------------------------------------- */
  function normalize(text) {
    return String(text || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  function classifyMethod(metodo) {
    const m = normalize(metodo);
    if (m.includes("eletromagnetico")) return "em";
    if (m.includes("gamaespectrometria")) return "gama";
    if (m.includes("gradiometri")) return "grad";
    return "other";
  }

  /* ---------------------------------------------------------------
   * Camadas do mapa (criadas vazias; os dados entram depois)
   * ------------------------------------------------------------- */
  function initLayers() {
    // Séries do Banco de Dados Aero (ficam abaixo do Planageo)
    for (const s of SERIES) {
      map.addSource(s.key, { type: "geojson", data: EMPTY_FC() });
      map.addLayer({
        id: `${s.key}-fill`, type: "fill", source: s.key,
        paint: { "fill-color": s.color, "fill-opacity": 0.25 }
      });
      map.addLayer({
        id: `${s.key}-line`, type: "line", source: s.key,
        paint: { "line-color": s.outline, "line-width": 1.2 }
      });
    }

    // Planageo, colorido por grupo de método
    const groupColor = [
      "match", ["get", "_grp"],
      "em", METHOD_COLORS.em,
      "gama", METHOD_COLORS.gama,
      "grad", METHOD_COLORS.grad,
      METHOD_COLORS.other
    ];
    map.addSource("planageo", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "planageo-fill", type: "fill", source: "planageo",
      paint: { "fill-color": groupColor, "fill-opacity": 0.25 }
    });
    map.addLayer({
      id: "planageo-line", type: "line", source: "planageo",
      paint: { "line-color": groupColor, "line-width": 1.5 }
    });

    // Destaques: projetos Planageo e séries que intersectam o título
    map.addSource("selected-projects", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "selected-projects-fill", type: "fill", source: "selected-projects",
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.5 }
    });
    map.addLayer({
      id: "selected-projects-line", type: "line", source: "selected-projects",
      paint: { "line-color": "#b86b00", "line-width": 3 }
    });
    for (const s of SERIES) {
      map.addSource(`selected-${s.key}`, { type: "geojson", data: EMPTY_FC() });
      map.addLayer({
        id: `selected-${s.key}-fill`, type: "fill", source: `selected-${s.key}`,
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.5 }
      });
      map.addLayer({
        id: `selected-${s.key}-line`, type: "line", source: `selected-${s.key}`,
        paint: { "line-color": "#b86b00", "line-width": 3 }
      });
    }

    // Título ANM selecionado (por cima de tudo)
    map.addSource("selected-title", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "selected-title-fill", type: "fill", source: "selected-title",
      paint: { "fill-color": "#ef4444", "fill-opacity": 0.14 }
    });
    map.addLayer({
      id: "selected-title-line", type: "line", source: "selected-title",
      paint: { "line-color": "#d72e2e", "line-width": 2.5 }
    });

    // Clique: mostra todos os polígonos visíveis sob o cursor
    const clickable = [
      "planageo-fill",
      ...SERIES.map(s => `${s.key}-fill`)
    ];
    map.on("click", (event) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: clickable });
      if (!hits.length) return;
      const items = [];
      const seen = new Set();
      for (const h of hits) {
        const isPlanageo = h.layer.id === "planageo-fill";
        const id = isPlanageo ? `p-${h.properties.objectid}` : h.properties._sid;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push(isPlanageo
          ? { kind: "planageo", props: h.properties }
          : { kind: h.layer.id.replace("-fill", ""), props: h.properties });
      }
      showClickDetails(items);
    });
    map.on("mousemove", (event) => {
      const hit = map.queryRenderedFeatures(event.point, { layers: clickable }).length > 0;
      map.getCanvas().style.cursor = hit ? "pointer" : "";
    });
  }

  /* ---------------------------------------------------------------
   * Visibilidade das camadas (checkboxes)
   * ------------------------------------------------------------- */
  const layerChecks = () => Array.from(document.querySelectorAll("input[data-layer]"));

  function applyVisibility() {
    const checked = new Set(layerChecks().filter(c => c.checked).map(c => c.dataset.layer));

    // Planageo: filtro por grupo de método (vale para a camada base e para o destaque)
    const visibleGroups = ["em", "gama", "grad", "other"].filter(g => checked.has(g));
    const groupFilter = ["in", ["get", "_grp"], ["literal", visibleGroups]];
    for (const id of ["planageo-fill", "planageo-line", "selected-projects-fill", "selected-projects-line"]) {
      if (map.getLayer(id)) map.setFilter(id, groupFilter);
    }

    // Séries: liga/desliga a camada base e o destaque
    for (const s of SERIES) {
      const v = checked.has(s.key) ? "visible" : "none";
      for (const id of [`${s.key}-fill`, `${s.key}-line`, `selected-${s.key}-fill`, `selected-${s.key}-line`]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
      }
    }
    syncGroupCheckboxes();
  }

  function syncGroupCheckboxes() {
    for (const [groupId, groupName] of [["groupPlanageo", "planageo"], ["groupAero", "aero"]]) {
      const boxes = Array.from(document.querySelectorAll(`.layer-group[data-group="${groupName}"] input[data-layer]`))
        .filter(b => !b.closest("[hidden]"));
      const on = boxes.filter(b => b.checked).length;
      const master = $(groupId);
      master.checked = on === boxes.length && boxes.length > 0;
      master.indeterminate = on > 0 && on < boxes.length;
    }
  }

  function setupLayerPanel() {
    layerChecks().forEach(c => c.addEventListener("change", applyVisibility));
    for (const [groupId, groupName] of [["groupPlanageo", "planageo"], ["groupAero", "aero"]]) {
      $(groupId).addEventListener("change", (event) => {
        document.querySelectorAll(`.layer-group[data-group="${groupName}"] input[data-layer]`)
          .forEach(b => { b.checked = event.target.checked; });
        applyVisibility();
      });
    }
  }

  function setCount(key, n) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = `(${n.toLocaleString("pt-BR")})`;
  }

  /* ---------------------------------------------------------------
   * Rede
   * ------------------------------------------------------------- */
  async function postQuery(endpoint, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams(params)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ao consultar o serviço`);
    const data = await response.json();
    if (data.error) {
      const detail = data.error.message || JSON.stringify(data.error);
      throw new Error(detail);
    }
    return data;
  }

  async function loadPlanageo() {
    const idData = await postQuery(SGB_QUERY, {
      where: "1=1",
      returnIdsOnly: "true",
      f: "json"
    });
    const ids = idData.objectIds || [];
    if (!ids.length) {
      planageoFeatures = [];
      return;
    }

    const all = [];
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const data = await postQuery(SGB_QUERY, {
        objectIds: chunk.join(","),
        outFields: SGB_FIELDS,
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson"
      });
      all.push(...(data.features || []));
      projectSummaryEl.textContent = `Carregando projetos Planageo: ${all.length} de ${ids.length}…`;
    }

    // Classifica cada projeto por grupo de método
    const counts = { em: 0, gama: 0, grad: 0, other: 0 };
    for (const f of all) {
      f.properties = f.properties || {};
      f.properties._grp = classifyMethod(f.properties.metodo);
      counts[f.properties._grp]++;
    }
    planageoFeatures = all;
    map.getSource("planageo").setData({ type: "FeatureCollection", features: planageoFeatures });

    for (const [k, n] of Object.entries(counts)) setCount(k, n);
    if (counts.other > 0) {
      $("otherLayerRow").hidden = false;
      syncGroupCheckboxes();
    }
    applyVisibility();
  }

  async function loadSeries(def) {
    const response = await fetch(def.file);
    if (!response.ok) throw new Error(`HTTP ${response.status} ao carregar ${def.file}`);
    const gj = await response.json();
    const features = [];
    const bboxes = [];
    (gj.features || []).forEach((f, i) => {
      if (!f || !f.geometry) return;
      const feature = {
        type: "Feature",
        geometry: f.geometry,
        properties: { ...(f.properties || {}), _sid: `${def.key}-${i}` }
      };
      features.push(feature);
      bboxes.push(turf.bbox(feature));
    });
    seriesData[def.key] = { features, bboxes };
    map.getSource(def.key).setData({ type: "FeatureCollection", features });
    setCount(def.key, features.length);
    return features.length;
  }

  async function loadAllData() {
    const results = await Promise.allSettled([
      loadPlanageo(),
      ...SERIES.map(loadSeries)
    ]);

    const errors = [];
    const planageoResult = results[0];
    if (planageoResult.status === "rejected") {
      projectSummaryEl.textContent = "Não foi possível carregar os polígonos Planageo.";
      errors.push(`SGB: ${planageoResult.reason.message}`);
    }
    const seriesInfo = [];
    SERIES.forEach((s, i) => {
      const r = results[i + 1];
      if (r.status === "fulfilled") seriesInfo.push(`${s.label}: ${r.value}`);
      else errors.push(`${s.label}: ${r.reason.message}`);
    });

    if (planageoResult.status === "fulfilled") {
      projectSummaryEl.textContent =
        `${planageoFeatures.length} projetos Planageo carregados do SGB` +
        (seriesInfo.length ? ` · ${seriesInfo.join(" · ")} polígonos.` : ".");
    }
    if (errors.length) {
      setStatus(`Falha ao carregar: ${errors.join(" | ")}. Verifique a conexão, o CORS e se os arquivos GeoJSON estão na mesma pasta (use um servidor local, não file://).`, true);
    } else {
      setStatus("Camadas carregadas. Busque um título ANM.");
    }
  }

  /* ---------------------------------------------------------------
   * Busca de títulos ANM
   * ------------------------------------------------------------- */
  function escapeSql(value) {
    return value.trim().replace(/'/g, "''");
  }

  function buildWhere(type, raw) {
    const term = escapeSql(raw);
    if (!term) throw new Error("Digite um termo para buscar.");
    if (type === "processo") {
      // Pesquisa parcial nos formatos numérico e formatado do processo.
      return `(PROCESSO LIKE '%${term}%' OR DSProcesso LIKE '%${term}%')`;
    }
    if (type === "titular") return `UPPER(NOME) LIKE '%${term.toUpperCase()}%'`;
    return `UPPER(SUBS) LIKE '%${term.toUpperCase()}%'`;
  }

  function clearResults() {
    resultsEl.replaceChildren();
    summaryEl.textContent = "";
    selectedResultButton = null;
  }

  function textEl(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = text == null || text === "" ? "—" : String(text);
    if (className) el.className = className;
    return el;
  }

  async function searchTitles() {
    const type = $("searchType").value;
    const raw = $("searchInput").value;
    let where;
    try { where = buildWhere(type, raw); }
    catch (error) { setStatus(error.message, true); return; }

    searchButton.disabled = true;
    clearResults();
    setStatus("Consultando a base pública da ANM…");
    try {
      const countData = await postQuery(ANM_QUERY, {
        where,
        returnCountOnly: "true",
        f: "json"
      });
      const total = Number(countData.count || 0);
      if (!total) {
        summaryEl.textContent = "Nenhum título encontrado.";
        setStatus("Busca concluída.");
        return;
      }
      const data = await postQuery(ANM_QUERY, {
        where,
        outFields: ANM_FIELDS,
        returnGeometry: "false",
        orderByFields: type === "titular" ? "NOME ASC" : "PROCESSO ASC",
        resultRecordCount: "100",
        f: "json"
      });
      const features = data.features || [];
      summaryEl.textContent = `${total.toLocaleString("pt-BR")} resultado(s) na ANM; exibindo ${features.length}${total > features.length ? " (lista limitada a 100)" : ""}.`;
      for (const feature of features) {
        const attrs = feature.attributes || {};
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "result-item";
        const title = attrs.DSProcesso || attrs.PROCESSO || `ObjectID ${attrs.OBJECTID}`;
        const holder = attrs.NOME || "Titular não informado";
        btn.append(textEl("strong", `${title} — ${holder}`));
        btn.append(textEl("span", `${attrs.SUBS || "Substância não informada"} · ${attrs.FASE || "Fase não informada"} · ${attrs.UF || "UF não informada"}`));
        btn.append(textEl("span", `Área: ${formatArea(attrs.AREA_HA)} ha`));
        btn.addEventListener("click", () => selectTitle(attrs, btn));
        resultsEl.append(btn);
      }
      setStatus(total > features.length
        ? "Busca concluída. Há mais resultados do que os exibidos; refine o termo para reduzir a lista."
        : "Busca concluída. Selecione um título para cruzá-lo com Planageo e séries.");
    } catch (error) {
      setStatus(`Falha na consulta ANM: ${error.message}. Se for erro de CORS, será necessário um intermediário de servidor.`, true);
    } finally {
      searchButton.disabled = false;
    }
  }

  function formatArea(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—";
  }

  /* ---------------------------------------------------------------
   * Cruzamento título × (Planageo + séries)
   * ------------------------------------------------------------- */
  function intersectSeries(titleFeature) {
    const tb = turf.bbox(titleFeature);
    const out = {};
    for (const s of SERIES) {
      const data = seriesData[s.key];
      out[s.key] = [];
      if (!data) continue;
      data.features.forEach((f, i) => {
        const b = data.bboxes[i];
        // descarta rápido por caixa envolvente
        if (b[0] > tb[2] || b[2] < tb[0] || b[1] > tb[3] || b[3] < tb[1]) return;
        try {
          if (turf.booleanIntersects(titleFeature, f)) out[s.key].push(f);
        } catch (e) {
          console.warn(`Geometria inválida em ${s.key} (${f.properties._sid}):`, e);
        }
      });
    }
    return out;
  }

  async function selectTitle(attrs, button) {
    if (selectedResultButton) selectedResultButton.classList.remove("active");
    selectedResultButton = button;
    button.classList.add("active");
    setStatus(`Obtendo geometria do processo ${attrs.PROCESSO || attrs.DSProcesso || attrs.OBJECTID}…`);
    try {
      const geometryData = await postQuery(ANM_QUERY, {
        objectIds: String(attrs.OBJECTID),
        outFields: ANM_FIELDS,
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson"
      });
      const titleFeature = geometryData.features && geometryData.features[0];
      if (!titleFeature || !titleFeature.geometry) throw new Error("A ANM não retornou a geometria desse título.");
      activeTitleFeature = titleFeature;
      map.getSource("selected-title").setData({ type: "FeatureCollection", features: [titleFeature] });

      // Planageo: interseção feita pelo serviço do SGB
      const arcGeometry = geoJsonToEsriPolygon(titleFeature.geometry);
      const intersectionData = await postQuery(SGB_QUERY, {
        where: "1=1",
        geometry: JSON.stringify(arcGeometry),
        geometryType: "esriGeometryPolygon",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: SGB_FIELDS,
        returnGeometry: "false",
        f: "json"
      });
      const matches = (intersectionData.features || []).map(f => f.attributes);
      const ids = new Set(matches.map(p => String(p.objectid)));
      const selectedFeatures = planageoFeatures.filter(f => ids.has(String(f.properties?.objectid)));
      map.getSource("selected-projects").setData({ type: "FeatureCollection", features: selectedFeatures });

      // Séries 1000 e 3000: interseção feita no navegador (Turf.js)
      const seriesMatches = intersectSeries(titleFeature);
      for (const s of SERIES) {
        map.getSource(`selected-${s.key}`).setData({ type: "FeatureCollection", features: seriesMatches[s.key] });
      }

      showTitleDetails(attrs, matches, seriesMatches);
      fitGeometry(titleFeature.geometry);
      const serieTotal = SERIES.reduce((n, s) => n + seriesMatches[s.key].length, 0);
      setStatus(`Título selecionado. Interseção com ${matches.length} projeto(s) Planageo e ${serieTotal} polígono(s) das séries.`);
    } catch (error) {
      setStatus(`Não foi possível cruzar este título: ${error.message}`, true);
    }
  }

  function geoJsonToEsriPolygon(geometry) {
    if (geometry.type === "Polygon") {
      return { rings: geometry.coordinates, spatialReference: { wkid: 4326 } };
    }
    if (geometry.type === "MultiPolygon") {
      return { rings: geometry.coordinates.flat(), spatialReference: { wkid: 4326 } };
    }
    throw new Error(`Tipo de geometria não suportado: ${geometry.type}`);
  }

  function fitGeometry(geometry) {
    const coords = [];
    const walk = (value) => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        coords.push(value);
      } else {
        value.forEach(walk);
      }
    };
    walk(geometry.coordinates);
    if (!coords.length) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 11, duration: 700 });
  }

  /* ---------------------------------------------------------------
   * Painel de detalhes
   * ------------------------------------------------------------- */
  function showTitleDetails(properties, planageoMatches, seriesMatches) {
    detailsEl.replaceChildren();
    const dl = document.createElement("dl");
    const rows = [
      ["Processo", properties.DSProcesso || properties.PROCESSO],
      ["Titular", properties.NOME],
      ["Substância", properties.SUBS],
      ["Fase", properties.FASE],
      ["UF", properties.UF],
      ["Área (ha)", formatArea(properties.AREA_HA)],
      ["Último evento", properties.ULT_EVENTO]
    ];
    for (const [label, value] of rows) {
      dl.append(textEl("dt", label), textEl("dd", value));
    }
    detailsEl.append(dl);

    detailsEl.append(textEl("h3", `Planageo — interseções: ${planageoMatches.length}`, "subhead"));
    if (!planageoMatches.length) {
      detailsEl.append(textEl("p", "Nenhum polígono Planageo intersectou este título.", "muted"));
    }
    for (const p of planageoMatches) detailsEl.append(projectCard(p));

    for (const s of SERIES) {
      const list = seriesMatches[s.key] || [];
      detailsEl.append(textEl("h3", `${s.label} — interseções: ${list.length}`, "subhead"));
      if (!list.length) {
        detailsEl.append(textEl("p", `Nenhum polígono da ${s.label} intersectou este título.`, "muted"));
      }
      for (const f of list) detailsEl.append(serieCard(s, f.properties));
    }
  }

  function showClickDetails(items) {
    detailsEl.replaceChildren();
    for (const item of items) {
      if (item.kind === "planageo") {
        detailsEl.append(projectCard(item.props));
      } else {
        const s = SERIES.find(x => x.key === item.kind);
        detailsEl.append(serieCard(s, item.props));
      }
    }
  }

  function projectCard(p) {
    const card = document.createElement("div");
    card.className = "project-link";
    const name = p.projeto || `Projeto ${p.num_projeto || p.objectid || ""}`;
    card.append(textEl("strong", `${p.num_projeto || ""} ${name}`.trim()));
    card.append(textEl("p", `Bloco: ${p.bloco || "—"} · Previsão: ${p.ano_prev || "não informada"}`));
    card.append(textEl("p", `Métodos: ${p.metodo || "não informado"}`));
    if (p.area != null) card.append(textEl("p", `Área informada pelo SGB: ${formatArea(p.area)} km²`));
    if (p.km_estimado != null) card.append(textEl("p", `Extensão estimada: ${Number(p.km_estimado).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} km`));
    if (p.status) card.append(textEl("p", `Status: ${p.status}`));
    return card;
  }

  // Os atributos das séries não são conhecidos de antemão: mostra o nome (se achar)
  // e os demais atributos preenchidos.
  const TITLE_KEYS = ["projeto", "nome_projeto", "nome", "name", "titulo", "title", "levantamento", "id"];
  function serieCard(serie, props) {
    const card = document.createElement("div");
    card.className = "project-link";
    const keys = Object.keys(props).filter(k => !k.startsWith("_"));
    const titleKey = TITLE_KEYS.map(t => keys.find(k => k.toLowerCase() === t)).find(Boolean);
    const title = titleKey ? props[titleKey] : null;
    card.append(textEl("strong", title ? `${serie.label} — ${title}` : serie.label));
    let shown = 0;
    for (const k of keys) {
      if (k === titleKey) continue;
      const v = props[k];
      if (v == null || v === "" || v === "null") continue;
      if (shown >= 8) break;
      card.append(textEl("p", `${k}: ${v}`, "kv"));
      shown++;
    }
    return card;
  }

  /* ---------------------------------------------------------------
   * Eventos e inicialização
   * ------------------------------------------------------------- */
  $("searchButton").addEventListener("click", searchTitles);
  $("searchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchTitles();
  });
  $("searchType").addEventListener("change", () => {
    const placeholders = {
      processo: "Ex.: 2275/1935 ou 002.275/1935",
      titular: "Ex.: VALE, CSN, CBA",
      substancia: "Ex.: FERRO, OURO, COBRE"
    };
    $("searchInput").placeholder = placeholders[$("searchType").value];
  });

  setupLayerPanel();

  map.on("load", async () => {
    initLayers();
    applyVisibility();
    await loadAllData();
  });
})();
