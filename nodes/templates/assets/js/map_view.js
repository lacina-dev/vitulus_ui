// Desc: MapView for Vitulus WebUI

ROS3D.Viewer.prototype.resize = function(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
};


// ===========================================================================
// EXPLICIT 3D LAYER-ORDERING CONTRACT (vitulus_ui)
// ---------------------------------------------------------------------------
// All the overlaid ground layers in the map_view 3D scene live in a near-
// identical z-band (their meshes differ by only a couple of centimetres, and
// the camera looks straight down from far above). Once the occupancy grids
// were switched to transparent materials (c95753c/f37cf01) their draw order
// stopped being decided by depth-write and started being decided by THREE's
// transparent-object sort — which, with everything at ~z=0, is effectively a
// tie and let the aerial MapProxy tiles draw ON TOP of the maps. Users then
// saw only the aerial/costmaps with the served site_map hidden underneath.
//
// The robust fix is to stop relying on sub-centimetre z differences and pin an
// EXPLICIT paint order per layer via mesh.renderOrder, with depthWrite off on
// every overlapping layer so no layer's depth buffer occludes another. Lower
// renderOrder paints first (further back); higher paints last (on top).
//
//   aerial tiles      z=-0.05  renderOrder=-100   (bottom, under everything)
//   base map          z= 0.00  renderOrder=  0
//   local costmap     z=-0.01  renderOrder=  5
//   saved site_map    z=+0.01  renderOrder= 10
//   raster preview    z=+0.011 renderOrder= 11   (per-raster mgmt: RAW raster
//                                                 shown for side-by-side compare
//                                                 vs the served site_map; blue
//                                                 tint, between SITE and TERRAIN)
//   terrain DEM       z=-0.02  renderOrder= 12   (opt-in elevation plane; raised
//                                                 ABOVE the flat maps/costmaps so
//                                                 that when the user ticks Terrain
//                                                 it is actually visible on top of
//                                                 the occupancy grids rather than
//                                                 hidden beneath them — it is a
//                                                 default-off display layer, so
//                                                 occluding the flat maps while on
//                                                 is desired. Paint order is by
//                                                 renderOrder, NOT z: the terrain
//                                                 plane is FLAT (colour = height),
//                                                 keeps its tiny z=-0.02 bias, and
//                                                 like every layer here is
//                                                 transparent + depthWrite=false so
//                                                 renderOrder alone decides.)
//   edits overlay     (overlay) renderOrder= 15   (WP-D2 map editor, mapedits.js)
//   live obstacle_map z=+0.02  renderOrder= 20
//   direct raster map z=+0.021 renderOrder= 21   (direct 2D raster mapper,
//                                                 mapping.js — built straight
//                                                 from sensor rays (lidar +
//                                                 camera obstacle/free),
//                                                 independent of the octomap+
//                                                 DEM live/obstacle_map above;
//                                                 teal-tinted so it reads
//                                                 distinct from LIVE (orange),
//                                                 SITE (red) and PREVIEW (blue))
//   dock map          z=-0.002 renderOrder= 30
//   rain radar        (own z)  renderOrder=999    (depthTest off, existing)
//   location beacon   (origin) renderOrder=1000   (far-zoom "you are here" pin,
//                                                   depthTest off, ALWAYS on top
//                                                   — above the rain overlay too)
//
// MapLayerOpacity applies renderOrder+depthWrite (below) to every registered
// occupancy grid on creation and on every slider update; the aerial/terrain
// plain-plane groups set theirs directly where they are built (mapping.js).
// ===========================================================================
var MapLayerOrder = {
    AERIAL:  -100,
    BASE:       0,
    COSTMAP:    5,
    SITE:      10,
    PREVIEW:   11,   // per-raster mgmt RAW-raster preview (mapping.js), between
                     // SITE 10 and TERRAIN 12. Blue-tinted so it reads distinct
                     // from the served site_map when shown for A/B comparison.
    TERRAIN:   12,   // opt-in elevation plane, raised ABOVE the flat maps/costmaps
                     // (was -50) so ticking Terrain shows it on top; still below
                     // EDITS/LIVE. Flat plane, colour=height; renderOrder governs.
    EDITS:     15,   // WP-D2 map-editor edit_list overlay (mapedits.js)
    LIVE:      20,
    DIRECT:    21,   // direct 2D raster mapper overlay (mapping.js) — teal,
                     // sits just above LIVE so it reads on top when both
                     // layers are shown at once.
    DOCK:      30,
    RAIN:     999,
    BEACON:   1000,  // far-zoom location "you are here" pin (mapping.js) — sits
                     // above the rain overlay so it is never occluded.
    // z-offsets used by the plane groups + occupancy offsetPose (documentation
    // + single source of truth for the group-owned planes below).
    Z_AERIAL:  -0.05,
    Z_TERRAIN: -0.02
};


// ===========================================================================
// GLOBAL OCCUPANCY-MAP OPACITY MANAGER (vitulus_ui)
// ---------------------------------------------------------------------------
// One place that owns two user-facing controls that apply to ALL occupancy
// grid layers at once (the ROS3D.OccupancyGridClient meshes) — i.e. the base
// /navi_manager/map grid, the local costmap, the saved site_map and the live
// obstacle_map. It deliberately does NOT touch the rain radar or the aerial
// MapProxy tiles: those are plain textured planes with their own dedicated
// opacity sliders and are left completely independent.
//
//   (1) "Maps opacity" 0..100 %  -> whole-mesh material.opacity on every grid.
//       Cheap: just set material.opacity (+ transparent=true) on each client's
//       currentGrid mesh. Applied live on slider input AND re-applied whenever
//       a client (re)creates its mesh (we hook the client 'change' event), so
//       freshly arrived grids inherit the current setting.
//
//   (2) "Unknown opacity" 0..100 % -> alpha of UNKNOWN (-1 / 205-ish) cells
//       only, so the user can fade the "not-yet-mapped" grey while keeping
//       free/obstacle cells crisp (to see aerial/terrain beneath). This alpha
//       is baked into the grid TEXTURE by getColor() at build time, so a change
//       needs a texture rebuild. We keep the last OccupancyGrid message per
//       registered client and re-run its processMessage() to rebuild the
//       texture with the new unknown alpha. Slider input is debounced (~100 ms)
//       so dragging doesn't trigger a rebuild storm.
//
// Values persist in localStorage so they survive a page reload, and are read
// back by getColor() (unknown alpha) / applied to every registered mesh (whole
// opacity) as soon as the manager is constructed.
// ===========================================================================
// ---------------------------------------------------------------------------
// Settings-persistence helpers (2026-08-15 pass) — tiny localStorage wrappers
// shared by the view-state persistence below (HUD toggles, follow mode, log
// panel filters, drawer panel, camera pose, selected program). Absent key =>
// the supplied default; storage failures (private mode) silently keep defaults.
// Robot-side state is NEVER persisted here — the robot stays the source of
// truth for anything mirrored over ROS topics.
function uiPrefGet(key, dflt) {
    try {
        var v = localStorage.getItem(key);
        if (v !== null) { return v; }
    } catch (e) { /* localStorage unavailable */ }
    return dflt;
}
function uiPrefSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (e) { /* ignore */ }
}
function uiPrefDel(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

var MapLayerOpacity = {
    LS_MAPS: 'vitulus_maps_opacity',       // 0..1
    LS_UNKNOWN: 'vitulus_unknown_opacity', // 0..1 (fraction of each layer's
                                           //       native unknown alpha)
    maps_opacity: 1.0,      // whole-mesh opacity (0..1)
    unknown_frac: 1.0,      // unknown-cell alpha fraction (0..1)
    _clients: [],           // registered OccupancyGridClient instances
    _debounce: null,        // pending unknown-rebuild timer

    _clamp01: function (v, dflt) {
        v = parseFloat(v);
        if (!(v >= 0 && v <= 1)) { return dflt; }
        return v;
    },

    // load persisted values (called once, before any grid is built)
    load: function () {
        try {
            var m = localStorage.getItem(this.LS_MAPS);
            if (m !== null) { this.maps_opacity = this._clamp01(m, this.maps_opacity); }
            var u = localStorage.getItem(this.LS_UNKNOWN);
            if (u !== null) { this.unknown_frac = this._clamp01(u, this.unknown_frac); }
        } catch (e) { /* localStorage unavailable — keep defaults */ }
    },

    // Register an OccupancyGridClient so it participates in both controls AND
    // gets its explicit renderOrder from the layer-ordering contract.
    // Re-applies opacity + renderOrder + depthWrite every time the client
    // rebuilds its mesh (fresh map message), and remembers the last message so
    // an unknown-alpha change can rebuild its texture.
    //
    //   renderOrder: one of MapLayerOrder.* (defaults to BASE if omitted so a
    //   caller that forgets still gets sane paint order rather than a raw 0
    //   that ties with the aerial planes).
    registerClient: function (client, renderOrder) {
        if (!client || this._clients.indexOf(client) !== -1) { return; }
        this._clients.push(client);
        // stash the contract renderOrder on the client so _applyOpacityToClient
        // (called on every 'change') can re-pin it after each mesh rebuild.
        client._layerRenderOrder = (typeof renderOrder === 'number')
            ? renderOrder : MapLayerOrder.BASE;
        var self = this;
        // Capture each incoming message so an Unknown-alpha change can force a
        // texture rebuild later. OccupancyGridClient.subscribe() bound the
        // ORIGINAL processMessage as the rosTopic callback at construction time,
        // so merely reassigning client.processMessage would never be invoked.
        //
        // IMPORTANT (latched topics): site_map and /navi_manager/map are LATCHED
        // — the grid message arrives exactly once, on serve/map-load. The old
        // code did rosTopic.unsubscribe() + rosTopic.subscribe(wrapped), which
        // (a) risks dropping the already-delivered latched message and (b) left
        // the original bound callback registered (unsubscribe() with no arg does
        // NOT remove a specific listener), so BOTH ran. We now DON'T touch the
        // subscription at all: roslibjs Topic is an EventEmitter, so we just add
        // our wrapper as an extra 'message' listener via rosTopic.subscribe().
        // The original processMessage keeps building the grid; our listener only
        // records _lastMsg. No unsubscribe => the latched message is never lost,
        // and processMessage runs exactly once per frame.
        try {
            if (client.rosTopic && typeof client.rosTopic.subscribe === 'function') {
                client.rosTopic.subscribe(function (message) {
                    client._lastMsg = message;
                });
            } else {
                // fallback: no live rosTopic — wrap the method (best-effort)
                var origProc = client.processMessage.bind(client);
                client.processMessage = function (message) {
                    client._lastMsg = message;
                    return origProc(message);
                };
            }
        } catch (e) { /* best-effort */ }
        // whenever the client (re)creates currentGrid, re-apply the full style
        try {
            client.on('change', function () { self._applyOpacityToClient(client); });
        } catch (e) { /* best-effort */ }
        // apply immediately in case a grid already exists
        this._applyOpacityToClient(client);
    },

    // Apply the full per-layer style to a client's current mesh: whole-mesh
    // opacity, transparent=true, depthWrite=false (grids overlap in a near-
    // identical z-band, so paint order is decided by renderOrder, NOT depth),
    // and the explicit contract renderOrder captured at registration.
    _applyOpacityToClient: function (client) {
        try {
            var mesh = client && client.currentGrid;
            if (mesh) {
                if (typeof client._layerRenderOrder === 'number') {
                    mesh.renderOrder = client._layerRenderOrder;
                }
                if (mesh.material) {
                    mesh.material.opacity = this.maps_opacity;
                    mesh.material.transparent = true;
                    mesh.material.depthWrite = false;
                    mesh.material.needsUpdate = true;
                }
            }
        } catch (e) { /* best-effort */ }
    },

    // (1) whole-mesh opacity — live, cheap, no texture rebuild.
    setMapsOpacity: function (v) {
        this.maps_opacity = this._clamp01(v, this.maps_opacity);
        try { localStorage.setItem(this.LS_MAPS, String(this.maps_opacity)); } catch (e) {}
        for (var i = 0; i < this._clients.length; i++) {
            this._applyOpacityToClient(this._clients[i]);
        }
    },

    // (2) unknown-cell alpha — needs a texture rebuild, so debounce and
    // re-run each client's processMessage() with its cached last message.
    setUnknownFrac: function (v) {
        this.unknown_frac = this._clamp01(v, this.unknown_frac);
        try { localStorage.setItem(this.LS_UNKNOWN, String(this.unknown_frac)); } catch (e) {}
        var self = this;
        if (this._debounce) { clearTimeout(this._debounce); }
        this._debounce = setTimeout(function () {
            self._debounce = null;
            self._rebuildUnknown();
        }, 100);
    },

    _rebuildUnknown: function () {
        for (var i = 0; i < this._clients.length; i++) {
            var c = this._clients[i];
            try {
                if (c && c._lastMsg) { c.processMessage(c._lastMsg); }
            } catch (e) { /* best-effort — a bad message must not kill the loop */ }
        }
    },

    // Scale a layer's native unknown-cell alpha (0..255) by the current
    // unknown fraction. Called from getColor() for every unknown cell.
    unknownAlpha: function (nativeAlpha) {
        return Math.round(nativeAlpha * this.unknown_frac);
    }
};
MapLayerOpacity.load();


// ===========================================================================
// OCCUPANCY-GRID COLOR PALETTE (vitulus_ui)
// ---------------------------------------------------------------------------
// Single source of truth for every layer's free/obstacle/unknown RGBA values,
// used by getColor() below. IMPORTANT: these alphas are tuned for readability
// OVER the aerial/satellite imagery layer (MapProxy tiles, z=Z_AERIAL, drawn
// UNDERNEATH — see MapLayerOrder above), NOT for the old plain-black viewer
// background. The original alphas (free ~110-160) were picked back when the
// aerial layer did not exist and washed out almost invisibly once the imagery
// is showing at Maps-opacity=100%, leaving only the ROS3D.Grid reference grid
// lines (see ViewerGrid, further below) visible — reported as "mapa je vidět
// jen v linkách gridu". Free-cell alphas were raised so the map itself reads
// clearly over the photo; obstacles were already opaque and are unchanged.
// The "Unknown opacity" UI slider still multiplies on top of the native
// unknown alpha here (MapLayerOpacity.unknownAlpha()) — kept LOW by default
// (native 120) so not-yet-mapped grey doesn't blanket the imagery, but is
// still visibly present (not near-zero) at slider=100%.
// ===========================================================================
var MapPalette = {
    // base /navi_manager/map grid (cyan identifier {0,255,255}).
    BASE: {
        obstacle:      [0, 0, 0, 255],
        free:          [149, 149, 149, 180],   // was 150 -> 180 (light grey, reads over imagery)
        unknownNative: 120                     // was 150 -> 120 (native cap for the Unknown slider)
    },
    // Mapping v3 LIVE obstacle_map (green identifier {0,255,0}); overlays the
    // loaded map, so unknown stays fully transparent (not a slider target).
    LIVE: {
        obstacle:      [255, 120, 0, 255],
        obstacleProb:  [255, 120, 0, 140],
        free:          [0, 200, 80, 110]
    },
    // Mapping v3 SAVED site_map (blue identifier {0,100,255}): the persistent
    // ground layer. Free = light grey-green so the driveable area reads
    // clearly over imagery; obstacles = solid red so they POP; unknown fully
    // transparent (nothing mapped there yet).
    SITE: {
        obstacle:      [230, 40, 40, 255],
        obstacleProb:  [230, 40, 40, 150],
        free:          [170, 205, 150, 180]    // was 160 -> 180
    },
    // Per-raster mgmt RAW-raster PREVIEW (identifier {40,140,255}): shown for
    // side-by-side comparison against the served site_map, so it is deliberately
    // BLUE-tinted (obstacles blue, free pale blue) to read as visually distinct
    // from the served map's red obstacles / grey-green free. Unknown transparent.
    PREVIEW: {
        obstacle:      [40, 110, 255, 255],
        obstacleProb:  [40, 110, 255, 150],
        free:          [120, 175, 255, 170]
    },
    // Direct 2D raster mapper (teal identifier {0,180,180}): the live raster
    // built straight from sensor rays (lidar hits/no-hit-free + camera
    // obstacle/free), independent of the octomap+DEM LIVE pipeline. Kept
    // deliberately teal so it reads as its own layer next to LIVE (orange),
    // SITE (red) and PREVIEW (blue). Unknown fully transparent (nothing
    // observed there yet).
    DIRECT: {
        // user 19.7.: obstacles BLACK (classic map look), free a soft white
        // wash so driven/observed area reads over the aerial imagery.
        obstacle:      [0, 0, 0, 255],
        obstacleProb:  [40, 40, 40, 170],
        free:          [255, 255, 255, 110]
    },
    // local costmap (magenta identifier {255,0,255}) — deliberately near-
    // invisible free space (it's a fast-changing overlay on top of BASE/SITE,
    // not a ground layer); left as-is.
    LOCAL_COSTMAP: {
        obstacle:      [255, 0, 0, 255],
        free:          [0, 0, 0, 10],
        unknownNative: 1
    },
    // global costmap (yellow identifier {255,255,0}) — free space
    // intentionally invisible (native alpha 0); left as-is.
    GLOBAL_COSTMAP: {
        obstacle:      [0, 0, 0, 255],
        free:          [149, 149, 149, 0],
        unknownNative: 0
    }
};

// Override getColor() of OccupancyGrid for custom coloring of maps depends on type.
// It's controled through the color attr of OccupancyGridClient
ROS3D.OccupancyGrid.prototype.getColor = function(index, row, col, value) {
    //  Occupancy identifiers in color attribute of OccupancyGridClient
    //  {r:0,g:255,b:255} gridmap,
    //  {r:255,g:0,b:255} loc costmap,
    //  {r:255,g:255,b:0} glob costmap

    // If map is not costmap.
    if (this.color.r === 0 && this.color.g === 255 && this.color.b === 255){
        var P = MapPalette.BASE;
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value === 0){    // free space
            return P.free;
        };
        if (value <= 99 && value >= 1){  // probably obstacle
            return [149-value,149-value,149-value,P.free[3]];
        };
        // unknown (-1) and the 205-ish "no info" value costmaps sometimes use:
        // route the alpha through the global Unknown-opacity control so the
        // not-yet-mapped grey can be faded to reveal aerial/terrain beneath.
        if (value === -1 || value === 205){  // unknown
            return [0,0,0,MapLayerOpacity.unknownAlpha(P.unknownNative)];
        };
    };

    // If map is the Mapping v3 live grid (green identifier): overlays the
    // loaded map, so unknown must stay fully transparent.
    if (this.color.r === 0 && this.color.g === 255 && this.color.b === 0){
        var P = MapPalette.LIVE;
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value >= 1 && value <= 99){  // probably obstacle
            return P.obstacleProb;
        };
        if (value === 0){    // mapped free space
            return P.free;
        };
        return [0,0,0,MapLayerOpacity.unknownAlpha(0)];    // unknown: invisible
    };

    // If map is the Mapping v3 SAVED site_map (blue identifier {0,100,255}):
    // the persistent ground layer of the 3D view. Free = light grey-green so
    // the driveable area reads clearly; obstacles = solid red so they POP;
    // unknown = fully transparent (nothing mapped there yet).
    if (this.color.r === 0 && this.color.g === 100 && this.color.b === 255){
        var P = MapPalette.SITE;
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value >= 1 && value <= 99){  // probably obstacle
            return P.obstacleProb;
        };
        if (value === 0){    // mapped free space
            return P.free;
        };
        return [0,0,0,MapLayerOpacity.unknownAlpha(0)];    // unknown: invisible
    };

    // If map is the per-raster mgmt RAW-raster PREVIEW (blue identifier
    // {40,140,255}): a temporary overlay for A/B comparison against the served
    // site_map, so unknown stays fully transparent (nothing to compare there).
    if (this.color.r === 40 && this.color.g === 140 && this.color.b === 255){
        var P = MapPalette.PREVIEW;
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value >= 1 && value <= 99){  // probably obstacle
            return P.obstacleProb;
        };
        if (value === 0){    // mapped free space
            return P.free;
        };
        return [0,0,0,MapLayerOpacity.unknownAlpha(0)];    // unknown: invisible
    };

    // If map is the DIRECT 2D raster mapper (teal identifier {0,180,180}):
    // overlays like LIVE, so unknown stays fully transparent (nothing
    // observed there yet).
    if (this.color.r === 0 && this.color.g === 180 && this.color.b === 180){
        var P = MapPalette.DIRECT;
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value >= 1 && value <= 99){  // probably obstacle
            return P.obstacleProb;
        };
        if (value === 0){    // observed free space
            return P.free;
        };
        return [0,0,0,MapLayerOpacity.unknownAlpha(0)];    // unknown: invisible
    };

    // If map is local costmap.
    if (this.color.r === 255 && this.color.g === 0 && this.color.b === 255){
        var P = MapPalette.LOCAL_COSTMAP;
        // this.opacity = 0.4;
        // console.log(value);
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value === 0){    // free space
            return P.free;
        };
        // if (value <= 99 && value >= 1){  // probably obstacle
        //     return [149,149-value,149-value,255];
        // };
        if (value === -1 || value === 205){  // unknown
            return [0,0,0,MapLayerOpacity.unknownAlpha(P.unknownNative)];
        };
    };
    // If map is global costmap.
    if (this.color.r === 255 && this.color.g === 255 && this.color.b === 0){
        var P = MapPalette.GLOBAL_COSTMAP;
        if (value === 100){   // obstacle
            return P.obstacle;
        };
        if (value === 0){    // free space
            return P.free;
        };
        if (value <= 99 && value >= 1){  // probably obstacle
            return [149,149-value,149,125];
        };
        if (value === -1 || value === 205){  // unknown
            return [0,0,0,MapLayerOpacity.unknownAlpha(P.unknownNative)];
            // console.log(value);
        };
    };
    return [(value * this.color.r) / 255,
              (value * this.color.g) / 255,
              (value * this.color.b) / 255,
              255];
};


class PathListItemTemplate {
    constructor(item) {
        this.name = item;
        this.element =  `
            <div class="col-auto" style="overflow: hidden;margin-bottom: 3px;">
                <div class="input-group input-group-sm">
                    <button onclick="map_menu.path_clicked_exec('${this.name}')" class="btn btn-primary" type="button" style="width: 42px;">
                        <i class="fa fa-arrow-circle-right text-info"></i>
                    </button>
                    <span class="text-info input-group-text" style="padding-left: 5px;width: 143.1562px;padding-right: 5px;font-size: 13px;">
                        ${this.name}
                    </span>
                    <button onclick="map_menu.add_path_point('${this.name}')" class="btn btn-primary" type="button">Add</button>
                    <button onclick="map_menu.path_clicked_show('${this.name}')" class="btn btn-primary" type="button">Show</button>
                    <button onclick="map_menu.show_modal_remove_path('${this.name}')" class="btn btn-primary" type="button" style="width: 40px;">
                        <i class="fa fa-remove text-danger"></i>
                    </button>
                </div>
            </div>
            `;
    }
}


class ProgramZoneItemTemplate {
    constructor(zone) {
        this.zone = zone;
        this.name = zone.name;
        this.area = zone.area;
        this.length = zone.length;
        this.cut_height = zone.cut_height;
        this.rpm = zone.rpm;
        this.coverage_angle = zone.coverage_angle;
        this.paths_distance = zone.paths_distance;
        this.border_paths = zone.border_paths;
        this.paths = zone.paths.length;
        this.element =  `
            <div class="col-auto" style="margin-top: 4px;">
                <div style="background: #37434d;padding: 5px;border-radius: 4px;padding-left: 8px;padding-right: 8px;">
                    <div class="row" style="padding-left: 7px;padding-right: 7px;">
                        <div class="col-auto" style="padding-left: 5px;padding-right: 2px;">
                            <div class="d-flex align-items-center"><i class="fa fa-remove text-danger" title="Remove zone from program" style="cursor: pointer;margin-right: 6px;" onclick="programs.removeZoneFromProgram('${this.name}')"></i><span class="text-info" style="display: block;color: var(--bs-gray-500);font-size: 14px;padding-right: 6px;">
                                    ${this.name}
                                </span>
                            </div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                    Cut height: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.cut_height}
                                </span><span class="text-light" style="display: block;font-size: 14px;"> cm</span>
                            </div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                RPM: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.rpm}
                                </span></div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                Coverage angle: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.coverage_angle}
                                </span><span class="text-light" style="display: block;font-size: 14px;">°</span></div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                Path distance: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.paths_distance}
                                </span><span class="text-light" style="display: block;font-size: 14px;"> m</span></div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                Area: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.area}
                                </span><span class="text-light" style="display: block;font-size: 14px;"> m</span><span class="text-light" style="display: block;font-size: 9px;"> 2</span></div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                Length: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.length}
                                </span><span class="text-light" style="display: block;font-size: 14px;"> m</span></div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                Borders: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.border_paths}
                                </span></div>
                        </div>
                        <div class="col-auto" style="padding-right: 2px;padding-left: 5px;">
                            <div class="d-flex align-items-center"><span class="text-secondary" style="display: block;font-size: 14px;">
                                Paths: 
                                </span><span class="text-light" style="display: block;font-size: 14px;">
                                ${this.paths}
                                </span></div>
                        </div>
                    </div>
                </div>
            </div>
            `;
    }
}


class ProgramListItemTemplate {
    constructor(item, id) {
        this.program = id;
        this.name = item.name;
        this.length = item.length;
        this.area = item.area;
        this.last_duration = item.last_duration_minutes;
        this.element =  `
            <div class="col-auto prog-row-fluid" style="overflow: hidden;margin-bottom: 3px;">
                <div class="input-group input-group-sm">
                    <button onclick="programs.show_program(${this.program})" class="btn btn-primary" type="button" style="width: 42px;">
                        <i class="fa fa-arrow-circle-right text-info"></i>
                    </button>
                    <span class="text-info input-group-text prog-name" style="padding-left: 5px;padding-right: 5px;font-size: 13px;">
                        <span class="text-info" style="font-size: 13px;">
                            ${this.name} ${this.area}
                        </span>
                        <span class="text-info" style="font-size: 13px;padding-left: 3px;">m</span>
                        <span class="text-info" style="font-size: 9px;">2</span>
                    </span>
                </div>
            </div>
            `;
    }
}


class ItemList {
    constructor(ros, map_menu, type) {
        this.list = [];
        this.type = type;
        this.map_menu = map_menu;
        if (this.type === 'point'){
            this.list_Topic = new ROSLIB.Topic({
                ros : ros,
                name : '/navi_manager/map_point_str_list',
                messageType : 'vitulus_msgs/StringList'
            });
        }
        if (this.type === 'path'){
            this.list_Topic = new ROSLIB.Topic({
                ros : ros,
                name : '/navi_manager/map_path_str_list',
                messageType : 'vitulus_msgs/StringList'
            });
        }
        this.list_Topic.subscribe((message) => {
            // console.log(message);
            this.process_list(message);
        });
    }
    get_html(){
        let elements = "";
        this.list.forEach((item) => {
            elements += item.element;
        });
        return elements;
    }
    process_list(message){
        // Add new item to list if not exist in list.
        let change_list = false;
        message.string_list.forEach(async (msg_item) => {
            let add_new = true;
            this.list.forEach((item) => {
                if (item.name === msg_item){
                    add_new = false;
                }
            });
            if (add_new){
                change_list = true;
                if (this.type === 'path'){
                    this.list.push(new PathListItemTemplate(msg_item));
                }
                if (this.type === 'point') {
                    this.list.push(new PointListItemTemplate(msg_item));
                }
            }
        });
        // Remove item from list if not exist in message.
        this.list.forEach(async (item, index) => {
            let remove = true;
            message.string_list.forEach((msg_item) => {
                // console.log('item exist: ', item.name);
                if (msg_item === item.name){
                    remove = false;
                }
            });
            if (remove){
                change_list = true;
                delete this.list[index];
            }
        });
        // Redraw list if there was any change.
        if (change_list){
            // console.log(this.list);
            if (this.type === 'path'){
                this.map_menu.div_menu_path_items_row.innerHTML = this.get_html()
            }
            if (this.type === 'point') {
                this.map_menu.div_menu_point_items_row.innerHTML = this.get_html()
            }
        }
    }
}

class PointListItemTemplate {
    constructor(item) {
        this.name = item;
        this.element =  `
            <div class="col-auto" style="overflow: hidden;margin-bottom: 3px;">
                <div class="input-group input-group-sm">
                    <button onclick="map_menu.point_clicked_goal('${this.name}')" class="btn btn-primary" type="button" style="width: 42px;">
                        <i class="fa fa-map-marker text-info"></i>
                    </button>
                    <span class="text-info input-group-text" style="padding-left: 5px;width: 185.9219px;padding-right: 5px;font-size: 13px;">
                        ${this.name}
                    </span>
                    <button onclick="map_menu.point_clicked_show('${this.name}')" class="btn btn-primary" type="button">Show</button>
                    <button onclick="map_menu.show_modal_remove_point('${this.name}')" class="btn btn-primary" type="button" style="width: 40px;">
                        <i class="fa fa-remove text-danger"></i>
                    </button>
                </div>
            </div>
            `;
    }
}


class MapList {
    constructor(ros, map_menu) {
        this.map_list = [];
        this.map_menu = map_menu;
        this.map_list_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/map_str_list',
            messageType : 'vitulus_msgs/StringList'
        });
        this.map_list_Topic.subscribe((message) => {
            this.process_map_list(message);
        });
    }
    get_html(){
        let map_elements = "";
        this.map_list.forEach((map) => {
            map_elements += map.element;
        });
        return map_elements;
    }
    process_map_list(message){
        // Add new maps to map_list if not exist in map_list.
        let change_list = false;
        message.string_list.forEach(async (map) => {
            let add_new = true;
            this.map_list.forEach((map_item) => {
                if (map_item.map === map){
                    add_new = false;
                }
            });
            if (add_new){
                change_list = true;
                const items = map.split('***env*');
                const map_name = items[0];
                const items2 = items[1].split(' (');
                const map_type = items2[0];
                const map_size = items2[1].replace(' GB)', '');
                this.map_list.push(new MapListItemTemplate(map_name, map_type, map_size, map));
            }
        });
        // Remove maps from map_list if not exist in message.
        this.map_list.forEach(async (map, index) => {
            let remove = true;
            message.string_list.forEach((map_item) => {
                // console.log('map exist: ', map_item.map);
                if (map_item === map.map){
                    remove = false;
                }
            });
            if (remove){
                change_list = true;
                delete this.map_list[index];
            }
        });
        // Redraw map_list if there was any change.
        if (change_list){
            // console.log(this.map_list);
            this.map_menu.div_menu_map_items_row.innerHTML = this.get_html()
        }
    }
}

class MapListItemTemplate {
    constructor(name, type, size, map) {
        this.name = name;
        this.map = map;
        this.file_name = name + '***env*' + type;
        this.type = type;
        this.ico = 'fa fa-tree';
        if (type === 'INDOOR'){
            this.ico = 'fa fa-home';
        }
        this.size = size;
        this.element =  `<div class="col-auto" style="overflow: hidden;margin-bottom: 3px;">
                            <div class="input-group input-group-sm">
                                <button onclick="map_menu.load_clicked_map('${this.file_name}', '${this.type}')" class="btn btn-primary" type="button" style="width: 42px;">
                                    <i class="fa fa-arrow-circle-right text-info"></i>
                                </button>
                                <span class="text-info input-group-text" style="padding-left: 5px;width: 237.1562px;padding-right: 4px;">
                                    <span style="font-size: 13px;width: 164.797px;text-align: left;">
                                        ${this.name}
                                    </span>
                                    <span>
                                        <span style="padding-right: 0px;padding-left: 0px;border-right-style: none;border-left-style: none;font-size: 12px;color: var(--bs-gray-500);margin-left: 2px;">
                                            ${this.size}
                                        </span>
                                        <span style="padding-right: 0px;padding-left: 0px;border-right-style: none;border-left-style: none;font-size: 9px;color: var(--bs-gray-500);">
                                         GB
                                        </span>
                                        <span class="text-info d-inline-flex justify-content-center align-items-center" style="display: inline-flex;width: 20px;margin-right: -5px;">
                                            <i class="${this.ico}" style="font-size: 11px;color: var(--bs-light);"></i>
                                        </span>
                                    </span>
                                </span>
                                <button onclick="map_menu.show_modal_remove_map('${this.name}', '${this.file_name}')" class="btn btn-primary" type="button" style="width: 40px;">
                                    <i class="fa fa-remove text-danger"></i>
                                </button>
                            </div>
                        </div>`;
    }
}


class ROS {
    constructor() {
        this._url = 'ws://' + location.hostname + ':' + (window.__ROSBRIDGE_PORT || 9090);
        this._reconnect_timer = null;
        this._reconnect_delay = 1500;       // start at 1.5s
        this._reconnect_delay_max = 8000;   // cap at 8s
        this.state = 'connecting';          // 'connecting' | 'connected' | 'disconnected'
        this._suspended = false;            // vitulus_ui: paused while the map section is hidden
        this._hb_svc = null;                // heartbeat service, recreated on each connect
        this._last_msg_at = 0;              // timestamp of last WebSocket data frame received
        this._hb_active = false;            // active service check in flight
        // groovyCompatibility:false → TFClient uses the /republish_tfs SERVICE
        // interface instead of actionlib goals. Action goals are NEVER reaped
        // when a browser tab dies (no cancel on unload), so a day of page
        // reloads piled up 61 live goals × 20 Hz = ~1200 feedback msgs/s:
        // rosbridge at 68% CPU and every browser drowning in parsing → lidar
        // scan / point clouds rendered with a growing replay-delay while the
        // tiny footprint polygon stayed live. The service interface gives each
        // client a dedicated topic the C++ republisher auto-unadvertises once
        // it has had no subscribers for `topicTimeout` — dead tabs clean
        // themselves up.
        this.ros = new ROSLIB.Ros({url: this._url, groovyCompatibility: false});
        var self = this;

        var emit = function(name, detail) {
            try { document.dispatchEvent(new CustomEvent(name, {detail: detail || {}})); } catch (e) {}
        };

        this.ros.on('connection', function() {
            console.log('[ROS] connected');
            self.state = 'connected';
            self._reconnect_delay = 1500;
            self._last_msg_at = Date.now();
            self._hb_active = false;
            if (self._reconnect_timer) { clearTimeout(self._reconnect_timer); self._reconnect_timer = null; }

            // Hook raw WebSocket onmessage to passively track liveness.
            // Every rosbridge data frame (topic msg, service response, server ping-ack)
            // is proof the connection is alive — no service call needed while data flows.
            if (self.ros.socket) {
                var orig = self.ros.socket.onmessage;
                self.ros.socket.onmessage = function(evt) {
                    self._last_msg_at = Date.now();
                    if (orig) orig.call(this, evt);
                };
            }

            // Recreate heartbeat service with the fresh socket.
            self._hb_svc = new ROSLIB.Service({
                ros: self.ros,
                name: '/rosapi/get_param',
                serviceType: 'rosapi/GetParam'
            });
            emit('rosconnected');
        });
        this.ros.on('error', function(error) {
            console.warn('[ROS] error:', error);
            emit('roserror', {error: error});
        });
        this.ros.on('close', function() {
            var was = self.state;
            self.state = 'disconnected';
            self._hb_svc = null;
            self._hb_active = false;
            if (self._suspended) return;   // vitulus_ui: intentional pause, do not reconnect
            console.warn('[ROS] disconnected, reconnecting in', self._reconnect_delay, 'ms');
            if (was !== 'disconnected') emit('rosdisconnected');
            self._scheduleReconnect();
        });

        // Two-stage liveness check — co-operating with rosbridge:
        //
        // Stage 1 (passive): rosbridge sends data frames for every subscribed topic.
        //   _last_msg_at is updated on every raw WebSocket message.
        //   → Zero extra traffic while topics are publishing normally.
        //
        // Stage 2 (active): If no data has arrived for >5 s (robot idle or WiFi half-open),
        //   fire a lightweight rosapi service call. rosbridge is configured with
        //   websocket_ping_interval=1/timeout=4, so the server already knows we're here;
        //   we just need the reverse confirm. If no service response within 4 s → dead.
        //
        // Detection time: ≤ 5 s (passive silence window) + ≤ 4 s (service timeout) = ≤ 9 s.
        setInterval(function() {
            if (self._suspended) return;
            if (self.state !== 'connected' || !self._hb_svc) return;
            var silence = Date.now() - self._last_msg_at;
            // Data flowing recently — connection is definitely alive.
            if (silence < 5000) return;
            // Data has been silent for >5 s — do active check (once at a time).
            if (self._hb_active) return;
            self._hb_active = true;
            var timed_out = false;
            var deadline = setTimeout(function() {
                if (self.state !== 'connected') { self._hb_active = false; return; }
                timed_out = true;
                self._hb_active = false;
                console.warn('[ROS] heartbeat timeout — TCP half-open, forcing disconnect');
                self.state = 'disconnected';
                self._hb_svc = null;
                emit('rosdisconnected');
                try { self.ros.socket.close(); } catch(e) {}
                self._scheduleReconnect();
            }, 4000);
            self._hb_svc.callService(
                new ROSLIB.ServiceRequest({name: '/use_sim_time', default: 'false'}),
                function() { self._hb_active = false; if (!timed_out) clearTimeout(deadline); },
                function() { self._hb_active = false; if (!timed_out) clearTimeout(deadline); }
            );
        }, 3000);
    }

    // vitulus_ui: pause/resume the whole map-view ROS connection so its heavy
    // subscriptions (SLAM occupancy grid, laser, point clouds, camera) stop
    // consuming CPU/GC while the user is on another section. Mirrors a normal
    // disconnect/reconnect, which map_view already recovers from.
    suspend() {
        if (this._suspended) return;
        this._suspended = true;
        if (this._reconnect_timer) { clearTimeout(this._reconnect_timer); this._reconnect_timer = null; }
        this.state = 'disconnected';
        try { if (this.ros.socket) this.ros.socket.close(); } catch (e) {}
    }
    resume() {
        if (!this._suspended) return;
        this._suspended = false;
        this._reconnect_delay = 1500;
        this.state = 'connecting';
        try { this.ros.connect(this._url); } catch (e) { this._scheduleReconnect(); }
    }

    _scheduleReconnect() {
        var self = this;
        if (self._suspended) return;
        if (self._reconnect_timer) return;
        self.state = 'connecting';
        try { document.dispatchEvent(new CustomEvent('rosconnecting')); } catch (e) {}
        self._reconnect_timer = setTimeout(function() {
            self._reconnect_timer = null;
            try { self.ros.connect(self._url); } catch (e) { console.warn('[ROS] connect() threw:', e); }
            // exponential backoff (1.5 -> 3 -> 6 -> 8)
            self._reconnect_delay = Math.min(self._reconnect_delay * 2, self._reconnect_delay_max);
            // safety: if still not connected after the delay, schedule again
            setTimeout(function() {
                if (self.state !== 'connected' && !self._reconnect_timer) {
                    self._scheduleReconnect();
                }
            }, self._reconnect_delay + 500);
        }, self._reconnect_delay);
    }
}


/**
 * Visual connection-status indicator (top-right pill).
 * States: connected (green), connecting (orange), disconnected (red).
 * Listens to custom DOM events emitted by the ROS class.
 */
class ConnectionStatus {
    constructor(ros) {
        this.ros = ros;
        this.el = document.getElementById('conn_status');
        this.icon = document.getElementById('conn_status_icon');
        this.text = document.getElementById('conn_status_text');
        if (!this.el) return;
        var self = this;
        document.addEventListener('rosconnected',    function() { self.set('connected'); });
        document.addEventListener('rosconnecting',   function() { self.set('connecting'); });
        document.addEventListener('rosdisconnected', function() { self.set('disconnected'); });
        // Apply current state immediately (page may load already-connected)
        this.set(ros && ros.state ? ros.state : 'connecting');
        // Allow click to force an immediate reconnect attempt
        this.el.style.cursor = 'pointer';
        this.el.title = 'Click to reconnect';
        this.el.addEventListener('click', function() {
            if (self.ros.state !== 'connected') {
                if (self.ros._reconnect_timer) { clearTimeout(self.ros._reconnect_timer); self.ros._reconnect_timer = null; }
                self.ros._reconnect_delay = 500;
                self.ros._scheduleReconnect();
            }
        });
    }
    set(state) {
        if (!this.el) return;
        var conf = {
            connected:    {color: 'var(--bs-success)', txt: 'ONLINE', icon: 'la la-wifi',    pulse: false},
            connecting:   {color: 'var(--bs-warning)', txt: 'CONNECTING',   icon: 'la la-wifi',    pulse: true},
            disconnected: {color: 'var(--bs-danger)',  txt: 'OFFLINE', icon: 'la la-wifi',   pulse: false}
        };
        var c = conf[state] || conf.disconnected;
        this.el.style.color = c.color;
        if (this.text) this.text.textContent = c.txt;
        if (this.icon) {
            this.icon.className = c.icon;
            this.icon.style.color = c.color;
            this.icon.style.animation = c.pulse ? 'vitulus-spin 1s linear infinite' : 'none';
        }
    }
}


class Viewer3D{
    constructor(ros) {
        this.camHeihgt = 4;
        // vitulus_ui: the 3D map needs a WebGL context. On clients with hardware
        // acceleration turned off (or no usable GPU) THREE.WebGLRenderer throws,
        // which used to abort the whole initMapView() — so NO data widgets (status,
        // battery, motors, power, mower) were ever wired up. We now catch that and
        // fall back to a render-less "stub" viewer: the THREE scene graph still
        // works (it is pure JS), every map_view component keeps constructing, and
        // the rest of init — including all live data subscriptions — runs as usual.
        // The only thing missing is the on-screen 3D render, for which we show a
        // one-time warning banner explaining how to re-enable it.
        try {
            this.viewer = new ROS3D.Viewer({
                divID : 'map_view',
                width : 200,
                height : 200,
                near : 20,
                far : 6000,
                antialias : true,
                intensity : 1.0,
                alpha : 1.0,
                background : '#1e2f38',  // 1e2f38
                cameraPose : {  x : 0, y : 0, z : 1000 },
                displayPanAndZoomFrame : false
            });
            this.webgl = true;
            // vitulus_ui RENDER-ORDER FIX: ROS3D.Viewer forces
            // renderer.sortObjects = false (see ros3d.js), which makes THREE
            // render transparent objects in SCENE-INSERTION order and completely
            // IGNORE every mesh.renderOrder. Our whole flat-layer stack (aerial
            // tiles, terrain, all occupancy grids, rain) relies on renderOrder to
            // paint bottom-to-top — with sortObjects off, the lazily-created
            // aerial group (inserted last) painted OVER the maps. Turn depth-sort
            // back ON so the explicit MapLayerOrder contract is actually applied.
            try {
                if (this.viewer.renderer) { this.viewer.renderer.sortObjects = true; }
            } catch (e) { /* stub / no renderer */ }
        } catch (e) {
            console.error('[vitulus_ui] 3D map disabled — could not create a WebGL context:', e);
            this.webgl = false;
            this.viewer = make_stub_viewer();
            show_webgl_warning();
        }
    }

    changeViewerSize(){
        if (!this.webgl) return;   // no real renderer to resize
        var width = document.getElementById("map_view").offsetWidth;
        var height = document.getElementById("map_view").offsetHeight;
        var padding = parseInt((document.getElementById("map_view").style.padding).replace('px', ''));
        this.viewer.resize(width, height);
    };

    updateCam(){
        if (!this.webgl) return;   // stub camera needs no projection update
        // viewer.camera.focus = 100000.0;
        this.viewer.camera.filmGauge = 0.04;
        // viewer.camera.zoom = 120;
        this.viewer.camera.setFocalLength(1.0);
        this.viewer.camera.updateProjectionMatrix();
    };
}


// vitulus_ui: render-less stand-in for ROS3D.Viewer, used when WebGL is
// unavailable. It mirrors the real viewer's public surface (scene / camera /
// cameraControls / selectableObjects / addObject) using plain THREE objects,
// which work without a GL context. Visualisation clients add their meshes to
// `scene` as normal; nothing is painted, but nothing throws either, so the data
// path of initMapView() completes.
function make_stub_viewer() {
    var scene = new THREE.Scene();
    var selectable = new THREE.Group();
    scene.add(selectable);
    var camera = new THREE.PerspectiveCamera(40, 1, 20, 6000);
    camera.position.set(0, 0, 1000);
    return {
        scene: scene,
        camera: camera,
        selectableObjects: selectable,
        cameraControls: {
            center: new THREE.Vector3(),
            rotateLeft: function () {},
            update: function () {},
            addEventListener: function () {},
            thetaDelta: 0,
            phiDelta: 0
        },
        renderer: null,
        stopped: true,
        addObject: function (object, selectable2) {
            if (!object) return;
            if (selectable2) this.selectableObjects.add(object);
            else this.scene.add(object);
        },
        resize: function () {},
        start: function () {},
        stop: function () {}
    };
}


// vitulus_ui: one-time, dismissible banner shown when the 3D map cannot start
// because the browser has no WebGL context (usually hardware acceleration is
// switched off). Robot data still works; this only explains the missing 3D view.
function show_webgl_warning() {
    if (window.__vitulus_webgl_warned) return;
    window.__vitulus_webgl_warned = true;
    var show = function () {
        if (document.getElementById('vitulus_webgl_warning')) return;
        var bar = document.createElement('div');
        bar.id = 'vitulus_webgl_warning';
        bar.style.cssText =
            'position:fixed;top:0;left:0;right:0;z-index:99999;' +
            'background:#e8643c;color:#fff;font:14px/1.4 sans-serif;' +
            'padding:10px 44px 10px 16px;box-shadow:0 2px 8px rgba(0,0,0,.4);';
        bar.innerHTML =
            '<strong>3D map disabled — WebGL is not available in this browser.</strong> ' +
            'Robot status and controls still work, but the 3D map, laser and point ' +
            'cloud cannot be shown. This usually means hardware acceleration is ' +
            'turned off. Enable it (e.g. Chrome: Settings &rarr; System &rarr; ' +
            '“Use hardware acceleration when available”, or chrome://gpu) ' +
            'and reload the page.';
        var close = document.createElement('span');
        close.textContent = '×';
        close.style.cssText =
            'position:absolute;top:6px;right:14px;cursor:pointer;font-size:22px;line-height:1;';
        close.onclick = function () { bar.remove(); };
        bar.appendChild(close);
        document.body.appendChild(bar);
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
}


class ViewerGrid{
    constructor(viewer) {
        // vitulus_ui RENDER-ORDER FIX: ROS3D.Grid builds its lines with a plain
        // OPAQUE LineBasicMaterial (depthWrite=true) at z=0. Opaque objects draw
        // in the opaque pass BEFORE any transparent object and WRITE the depth
        // buffer, so the nearer grid lines (z=0) occluded the farther transparent
        // aerial tiles (z=-0.05) exactly along every reference line — the maps
        // (drawn earlier) then showed through ONLY along the grid lines while
        // aerial tiles covered them everywhere else (the reported symptom).
        // Make the grid depth-INERT: transparent + depthWrite=false so it never
        // punches holes in the depth buffer, and pin its renderOrder BELOW the
        // whole flat ground stack so it can never paint over the maps either.
        var grid = new ROS3D.Grid({num_cells : 50, color: "#333333", lineWidth: 0.1, cellSize: 1.0, });
        grid.renderOrder = (typeof MapLayerOrder !== 'undefined')
            ? (MapLayerOrder.AERIAL - 1) : -101;
        grid.traverse(function (obj) {
            if (obj && obj.material) {
                obj.material.transparent = true;
                obj.material.depthWrite = false;
                obj.material.needsUpdate = true;
                obj.renderOrder = grid.renderOrder;
            }
        });
        viewer.viewer.scene.add(grid);
    }
}


class TfClient {
    constructor(ros, viewer) {
        this.robot_cam_position = new THREE.Vector3();
        this.robot_cam_position.copy(viewer.camera.position);
        this.map_cam_position = new THREE.Vector3();
        this.map_cam_rotation = new THREE.Quaternion();
        this.map_cam_center = new THREE.Vector3();
        this.map_cam_position.copy(viewer.camera.position);
        this.map_cam_rotation.copy(viewer.camera.rotation);
        this.map_cam_center.copy(viewer.cameraControls.center);
        this.follow_target = 'map';
        this.map_reinit = true;
        this._was_disconnected = false;
        this.tfClientMap = new ROSLIB.TFClient({
          ros : ros.ros,
          angularThres : 0.00001,
          transThres : 0.00001,
          rate : 20.0,
          // service-mode only: republisher drops this client's topic after
          // 10 s with no subscribers (tab closed/crashed) — no goal leaks.
          topicTimeout : 10.0,
          fixedFrame : '/map'
        });

        var self = this;
        // After a real reconnect (e.g. robot reboot — `rvi`), tf2_web_republisher
        // has restarted and the previously-issued action goal / service request is
        // dead. Without this the visualizers keep drawing with the last-cached TFs
        // → lidar / pointcloud / path / footprint appear shifted from the map.
        // Re-issuing the goal makes the (new) republisher start streaming fresh
        // transforms for all subscribed frames.
        document.addEventListener('rosdisconnected', function() {
            self._was_disconnected = true;
        });
        document.addEventListener('rosconnected', function() {
            if (!self._was_disconnected) return;     // skip first-time connect
            self._was_disconnected = false;
            // Drop the stale topic handle so processResponse re-subscribes to the
            // new dynamically-named topic published by the fresh republisher.
            try {
                if (self.tfClientMap.currentTopic) {
                    self.tfClientMap.currentTopic.unsubscribe(self.tfClientMap._subscribeCB);
                    self.tfClientMap.currentTopic = false;
                }
            } catch (e) { console.warn('[TfClient] cleanup of stale topic failed:', e); }
            // Small grace period so rosbridge has finished re-advertising service /
            // action topics after reconnect, then re-issue.
            setTimeout(function() {
                try {
                    self.tfClientMap.updateGoal();
                    console.log('[TfClient] re-issued TF goal after reconnect');
                } catch (e) { console.warn('[TfClient] updateGoal failed:', e); }
            }, 500);
        });
    }

    follow_robot_set(viewer, tf){
        // console.log(this.follow_target);
        if (this.follow_target === 'map'){
            if (this.map_reinit){
                viewer.camera.position.x = this.map_cam_position.x;
                viewer.camera.position.y = this.map_cam_position.y;
                viewer.camera.position.z = this.map_cam_position.z;
                viewer.camera.rotation.x = this.map_cam_rotation.x;
                viewer.camera.rotation.y = this.map_cam_rotation.y;
                viewer.camera.rotation.z = this.map_cam_rotation.z;
                viewer.camera.rotation.w = this.map_cam_rotation.w;
                viewer.cameraControls.center.x = this.map_cam_center.x;
                viewer.cameraControls.center.y = this.map_cam_center.y;
                viewer.cameraControls.center.z = this.map_cam_center.z;
                this.map_reinit = false;
            }
        };
        if (this.follow_target === 'robot'){
            viewer.cameraControls.center.x = tf.translation.x;
            viewer.cameraControls.center.y = tf.translation.y;
            viewer.cameraControls.center.z = tf.translation.z;
            viewer.camera.position.x = tf.translation.x;
            viewer.camera.position.y = tf.translation.y;
            // 2026-08-16 v2: robot-follow keeps the CURRENT map orientation
            // (historically it was effectively north-up: the old thetaDelta
            // assignment was visually inert from the top-down pose — the
            // stateful-theta rotation fix suddenly made it SPIN the whole
            // scene with the robot yaw, which read as 'lidar/point clouds
            // rotate and fly around'). The camera now just FOLLOWS position;
            // the user's manual rotation stays untouched.
        };
        // vitulus_ui: the 'camera' ("Robot front" / chase) follow mode was removed.
    }
}


class Maps{
    constructor(ros, tf_client, viewer) {
        // base /navi_manager/map: z=0, renderOrder BASE (see MapLayerOrder).
        this.map_offset =new ROSLIB.Pose({ position : new ROSLIB.Vector3({ x : 0, y : 0, z : 0 }),
                    orientation : new ROSLIB.Quaternion({ x : 0.0, y : 0.0, z : 0.0, w : 1.0 }) });
        this.map = null;
        // local costmap: z=-0.01, renderOrder COSTMAP.
        this.local_costmap_offset = new ROSLIB.Pose({ position : new ROSLIB.Vector3({ x : 0, y : 0, z : -0.01 }),
                    orientation : new ROSLIB.Quaternion({ x : 0.0, y : 0.0, z : 0.0, w : 1.0 }) });
        this.local_costmap = null;
    }
}


class LaserScan{
    constructor(ros, tf_client, viewer) {

        this.laser = new ROS3D.LaserScan({
            ros : ros.ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/scan',
            material: { size: 3, color: 0x007bff }
        });
    }
}


class InteractiveMarkers{
    constructor(ros, tf_client, viewer) {
        this.imClient = new ROS3D.InteractiveMarkerClient({
          ros : ros,
          tfClient : tf_client,
          topic : '/interactive_marker',
          camera : viewer.camera,
          rootObject : viewer.selectableObjects
        });
        this.imClient.rootObject.visible = false;
        this.euler = new THREE.Euler(0, 0, 0, 'XYZ');
        this.newInteractiveMarkerTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/new_interactive_marker',
            messageType : 'geometry_msgs/Pose'
        });
        this.interactiveMarkerGoalTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/interactive_marker_goal',
            messageType : 'std_msgs/String'
        });


        this.init();
    }
    init(){
        this.newInteractiveMarkerTopic.advertise();
        this.interactiveMarkerGoalTopic.advertise();
    }

    send_goal(){
        // console.log('Sending interactive marker goal.');
        var interactiveMarkerGoalMsg = new ROSLIB.Message({
            data : 'interactiveGoal',
        });
        this.interactiveMarkerGoalTopic.publish(interactiveMarkerGoalMsg);
    }

    new_marker(event3d){
        // console.log(event3d.mouseRay);
        // vitulus_ui: proper ray/z=0-plane intersection (was: origin + direction *
        // origin.z, which assumes direction.z === -1 and is wrong for off-center
        // clicks / a tilted camera). Same math as Ros3dEditOverlay.screenToWorld()
        // in mapeditor.js.
        var ray_origin = event3d.mouseRay.origin;
        var ray_direction = event3d.mouseRay.direction;
        var map_x = 0, map_y = 0;
        if (Math.abs(ray_direction.z) > 1e-9) {
            var t = -ray_origin.z / ray_direction.z;
            map_x = ray_origin.x + t * ray_direction.x;
            map_y = ray_origin.y + t * ray_direction.y;
        } else {
            // ray parallel to z=0 plane: no intersection, bail (keep prior click point)
            return;
        }
        var newInteractiveMarkerMsg = new ROSLIB.Message({
            position : {
                      x : map_x,
                      y : map_y,
                      z : 0
                    },
                    orientation : {
                      x : 0.0,
                      y : 0.0,
                      z : 0.0,
                      w : 1.0
                    }
        });
        this.newInteractiveMarkerTopic.publish(newInteractiveMarkerMsg);
    }
}

class Clouds {
    constructor(ros, tf_client, viewer) {
        this.groung_cloud = new ROS3D.PointCloud2({
            ros : ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/ground_cloud',
            max_pts: 10000,
            // max_age: 0,
            // opacity: 1.0,
            // alpha: 1.0,
            pointRatio: 2.0,
            material: { size: 2.0, color: 0x71ff02 }
        });
        this.obstacle_cloud = new ROS3D.PointCloud2({
            ros : ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/obstacles_cloud',
            max_pts: 10000,
            // max_age: 60,
            // opacity: 1.0,
            // alpha: 1.0,
            pointRatio: 1.0,
            material: { size: 2.0, color: 0xfb0202 }
        });
    }
}


class RobotVisualization {
    constructor(ros, tf_client, viewer) {
        // 2026-08-16 (user request): the robot footprint sits ABOVE everything
        // (incl. dock graphics) and its colours are UI-configurable (Display
        // section -> Robot marker; persisted in localStorage, applied by the
        // periodic sweep below because ROS3D.Polygon rebuilds its meshes on
        // every footprint message).
        this.group = new THREE.Object3D();
        viewer.scene.add(this.group);
        this.robotPolygon = new ROS3D.Polygon({
            ros : ros,
            tfClient: tf_client,
            rootObject : this.group,
            topic: '/move_base_flex/local_costmap/footprint',
            color: 0xffffff,        // outline (live value applied by the sweep)
            fillColor: 0xffffff,    // filled interior
            fillOpacity: 0.35
        });
        var self = this;
        setInterval(function () {
            var frame = uiPrefGet('vitulus_robot_frame_color', '#ffffff');
            var fill = uiPrefGet('vitulus_robot_fill_color', '#ffffff');
            var fop = parseFloat(uiPrefGet('vitulus_robot_fill_opacity', '0.35'));
            self.group.traverse(function (o) {
                o.renderOrder = 55;   // ROBOT: above DOCK_VIZ 35 and every map layer
                if (!o.material) { return; }
                o.material.depthTest = false;
                if (o.isMesh) {
                    o.material.color.set(fill);
                    o.material.transparent = true;
                    o.material.opacity = isFinite(fop) ? fop : 0.35;
                } else if (o.isLine || o.isLineSegments) {
                    o.material.color.set(frame);
                }
            });
        }, 700);
    }
}


class PathsPointsVisualization {
    constructor(ros, tf_client, viewer) {
        this.localPlan = new ROS3D.Path({
            ros : ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/move_base_flex/TebLocalPlannerROS/local_plan_slow',
            color: 0xff00ff,
        });
        this.globalPlan = new ROS3D.Path({
            ros : ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/move_base_flex/TebLocalPlannerROS/global_plan_slow',
            color: 0xffffff,
        });
        this.mapMarker = new ROS3D.MarkerClient({
            ros : ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/navi_manager/map_point',
            color: 0x020cf9,
        });
        this.markerArrayClient = new ROS3D.MarkerArrayClient({
          ros: ros,
          rootObject: viewer.scene,
          tfClient: tf_client,
          topic: "/web_plan/program_marker",
        });
        this.mapPath = new ROS3D.Path({
            ros : ros,
            tfClient: tf_client,
            rootObject : viewer.scene,
            topic: '/navi_manager/map_path',
            color: 0x020cf9,
        });
    }
}


class IconStatus {
    constructor(ros) {
        this.ico_wifi = document.getElementById("ico_wifi");
        this.ico_gps = document.getElementById("ico_gps");
        this.ico_gps_nav = document.getElementById("ico_gps_nav");
        this.ico_imu = document.getElementById("ico_imu");
        this.ico_lidar = document.getElementById("ico_lidar");
        this.ico_camera = document.getElementById("ico_camera");
        this.ico_mower = document.getElementById("ico_mower");
        this.ico_fl_motor = document.getElementById("ico_fl_motor");
        this.ico_fr_motor = document.getElementById("ico_fr_motor");
        this.ico_rl_motor = document.getElementById("ico_rl_motor");
        this.ico_rr_motor = document.getElementById("ico_rr_motor");
        this.ico_temp_pcb = document.getElementById("ico_temp_pcb");
        this.ico_temp = document.getElementById("ico_temp");
        this.ico_fan = document.getElementById("ico_fan");
        this.ico_fan_pcb = document.getElementById("ico_fan_pcb");
        this.ico_supply = document.getElementById("ico_supply");
        this.ico_batt = document.getElementById("ico_batt");
        this.ico_fl_motor_conf = document.getElementById("ico_fl_motor_conf");
        this.ico_fr_motor_conf = document.getElementById("ico_fr_motor_conf");
        this.ico_rl_motor_conf = document.getElementById("ico_rl_motor_conf");
        this.ico_rr_motor_conf = document.getElementById("ico_rr_motor_conf");
        this.ico_temp_pcb_conf = document.getElementById("ico_temp_pcb_conf");
        this.ico_temp_conf = document.getElementById("ico_temp_conf");
        this.ico_fan_conf = document.getElementById("ico_fan_conf");
        this.ico_fan_pcb_conf = document.getElementById("ico_fan_pcb_conf");
        this.ico_supply_conf = document.getElementById("ico_supply_conf");
        this.ico_batt_conf = document.getElementById("ico_batt_conf");

        this.icon_status_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/device_state_pub/icon_status',
            messageType: 'vitulus_msgs/Device_icon_status'
        });
    }

    icon_data(message){
        // WiFi
            if (message.wifi === "FINE") {
                this.ico_wifi.src = "/assets/img/robot_icons/Nextion_ico_wifi_green.png";
            }
            if (message.wifi === "MEDIUM") {
                this.ico_wifi.src = "/assets/img/robot_icons/Nextion_ico_wifi_orange.png";
            }
            if (message.wifi === "BAD") {
                this.ico_wifi.src = "/assets/img/robot_icons/Nextion_ico_wifi_red.png";
            }
            if (message.wifi === "DISCONNECTED") {
                this.ico_wifi.src = "/assets/img/robot_icons/Nextion_ico_wifi_grey.png";
            }
            // GPS
            if (message.gnss === "RTK") {
                this.ico_gps.src = "/assets/img/robot_icons/Nextion_ico_gps_green.png";
            }
            if (message.gnss === "3DFIX") {
                this.ico_gps.src = "/assets/img/robot_icons/Nextion_ico_gps_orange.png";
            }
            if (message.gnss === "BAD") {
                this.ico_gps.src = "/assets/img/robot_icons/Nextion_ico_gps_red.png";
            }
            if (message.gnss === "DISABLED") {
                this.ico_gps.src = "/assets/img/robot_icons/Nextion_ico_gps_grey.png";
            }
            // GPS_NAV
            if (message.gnss_nav === "RTK") {
                this.ico_gps_nav.src = "/assets/img/robot_icons/Nextion_ico_gpsnav_green.png";
            }
            if (message.gnss_nav === "3DFIX") {
                this.ico_gps_nav.src = "/assets/img/robot_icons/Nextion_ico_gpsnav_orange.png";
            }
            if (message.gnss_nav === "BAD") {
                this.ico_gps_nav.src = "/assets/img/robot_icons/Nextion_ico_gpsnav_red.png";
            }
            if (message.gnss_nav === "DISABLED") {
                this.ico_gps_nav.src = "/assets/img/robot_icons/Nextion_ico_gpsnav_grey.png";
            }
            // IMU
            if (message.imu === "ON") {
                this.ico_imu.src = "/assets/img/robot_icons/Nextion_ico_imu_green.png";
            }
            else  {
                this.ico_imu.src = "/assets/img/robot_icons/Nextion_ico_imu_grey.png";
            }
            // LIDAR
            if (message.lidar === "ON") {
                this.ico_lidar.src = "/assets/img/robot_icons/Nextion_ico_lidar_green.png";
            }
            else  {
                this.ico_lidar.src = "/assets/img/robot_icons/Nextion_ico_lidar_grey.png";
            }
            // D435
            if (message.d435 === "ON") {
                this.ico_camera.src = "/assets/img/robot_icons/Nextion_ico_camera_green.png";
            }
            else  {
                this.ico_camera.src = "/assets/img/robot_icons/Nextion_ico_camera_grey.png";
            }
            // MOWER
            if (message.mower === "ON") {
                this.ico_mower.src = "/assets/img/robot_icons/Nextion_ico_mower_green.png";
            }
            if (message.mower === "BUSY") {
                this.ico_mower.src = "/assets/img/robot_icons/Nextion_ico_mower_orange.png";
            }
            if (message.mower === "ERROR") {
                this.ico_mower.src = "/assets/img/robot_icons/Nextion_ico_mower_red.png";
            }
            if (message.mower === "DISABLED") {
                this.ico_mower.src = "/assets/img/robot_icons/Nextion_ico_mower_grey.png";
            }
            // FL MOTOR
            if (message.mot_lf === "OK") {
                this.ico_fl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLF_green.png";
            }
            if (message.mot_lf === "WARM") {
                this.ico_fl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLF_orange.png";
            }
            if (message.mot_lf === "HOT") {
                this.ico_fl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLF_red.png";
            }
            if (message.mot_lf === "DISABLED") {
                this.ico_fl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLF_grey.png";
            }
            // FR MOTOR
            if (message.mot_rf === "OK") {
                this.ico_fr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRF_green.png";
            }
            if (message.mot_rf === "WARM") {
                this.ico_fr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRF_orange.png";
            }
            if (message.mot_rf === "HOT") {
                this.ico_fr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRF_red.png";
            }
            if (message.mot_rf === "DISABLED") {
                this.ico_fr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRF_grey.png";
            }
            // RL MOTOR
            if (message.mot_lr === "OK") {
                this.ico_rl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLR_green.png";
            }
            if (message.mot_lr === "WARM") {
                this.ico_rl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLR_orange.png";
            }
            if (message.mot_lr === "HOT") {
                this.ico_rl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLR_red.png";
            }
            if (message.mot_lr === "DISABLED") {
                this.ico_rl_motor.src = "/assets/img/robot_icons/Nextion_ico_motorLR_grey.png";
            }
            // RR MOTOR
            if (message.mot_rr === "OK") {
                this.ico_rr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRR_green.png";
            }
            if (message.mot_rr === "WARM") {
                this.ico_rr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRR_orange.png";
            }
            if (message.mot_rr === "HOT") {
                this.ico_rr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRR_red.png";
            }
            if (message.mot_rr === "DISABLED") {
                this.ico_rr_motor.src = "/assets/img/robot_icons/Nextion_ico_motorRR_grey.png";
            }
            // TEMP_PCB
            if (message.temp_int === "OK") {
                this.ico_temp_pcb.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_green.png";
            }
            if (message.temp_int === "WARM") {
                this.ico_temp_pcb.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_orange.png";
            }
            if (message.temp_int === "HOT") {
                this.ico_temp_pcb.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_red.png";
            }
            if (message.temp_int === "DISABLED") {
                this.ico_temp_pcb.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_grey.png";
            }
            // FAN_PCB
            if (message.fan_int === "ON") {
                this.ico_fan_pcb.src = "/assets/img/robot_icons/Nextion_ico_fanPCB_green.png";
            }
            else  {
                this.ico_fan_pcb.src = "/assets/img/robot_icons/Nextion_ico_fanPCB_grey.png";
            }
            // TEMP_EXT
            if (message.temp_ext === "OK") {
                this.ico_temp.src = "/assets/img/robot_icons/Nextion_ico_temp_green.png";
            }
            if (message.temp_ext === "WARM") {
                this.ico_temp.src = "/assets/img/robot_icons/Nextion_ico_temp_orange.png";
            }
            if (message.temp_ext === "HOT") {
                this.ico_temp.src = "/assets/img/robot_icons/Nextion_ico_temp_red.png";
            }
            if (message.temp_ext === "DISABLED") {
                this.ico_temp.src = "/assets/img/robot_icons/Nextion_ico_temp_grey.png";
            }
            // FAN_EXT
            if (message.fan_ext === "ON") {
                this.ico_fan.src = "/assets/img/robot_icons/Nextion_ico_fan_green.png";
            }
            else  {
                this.ico_fan.src = "/assets/img/robot_icons/Nextion_ico_fan_grey.png";
            }
            // supply
            if (message.supply === "ONLINE") {
                this.ico_supply.src = "/assets/img/robot_icons/Nextion_ico_supply_green.png";
            }
            else  {
                if (message.supply === "FAIL") {
                this.ico_supply.src = "/assets/img/robot_icons/Nextion_ico_supply_red.png";
                }
                else  {
                    this.ico_supply.src = "/assets/img/robot_icons/Nextion_ico_supply_grey.png";
                }
            }
            // BATTERY
            if (message.batt === "FULL") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_batt_full.png";
            }
            if (message.batt === "75") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_batt_34.png";
            }
            if (message.batt === "50") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_batt_half.png";
            }
            if (message.batt === "25") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_batt_14.png";
            }
            if (message.batt === "EMPTY") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_batt_empty.png";
            }
            if (message.batt === "FULL_CHARGE") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_full.png";
            }
            if (message.batt === "75_CHARGE") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_34.png";
            }
            if (message.batt === "50_CHARGE") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_half.png";
            }
            if (message.batt === "25_CHARGE") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_14.png";
            }
            if (message.batt === "EMPTY_CHARGE") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_empty.png";
            }
            if (message.batt === "DISABLED") {
                this.ico_batt.src = "/assets/img/robot_icons/Nextion_ico_batt_disabled.png";
            }

            // MOTOR CONFIG MENU  ///
            // FL MOTOR
            if (message.mot_lf === "OK") {
                this.ico_fl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLF_green.png";
            }
            if (message.mot_lf === "WARM") {
                this.ico_fl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLF_orange.png";
            }
            if (message.mot_lf === "HOT") {
                this.ico_fl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLF_red.png";
            }
            if (message.mot_lf === "DISABLED") {
                this.ico_fl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLF_grey.png";
            }
            // FR MOTOR
            if (message.mot_rf === "OK") {
                this.ico_fr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRF_green.png";
            }
            if (message.mot_rf === "WARM") {
                this.ico_fr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRF_orange.png";
            }
            if (message.mot_rf === "HOT") {
                this.ico_fr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRF_red.png";
            }
            if (message.mot_rf === "DISABLED") {
                this.ico_fr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRF_grey.png";
            }
            // RL MOTOR
            if (message.mot_lr === "OK") {
                this.ico_rl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLR_green.png";
            }
            if (message.mot_lr === "WARM") {
                this.ico_rl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLR_orange.png";
            }
            if (message.mot_lr === "HOT") {
                this.ico_rl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLR_red.png";
            }
            if (message.mot_lr === "DISABLED") {
                this.ico_rl_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorLR_grey.png";
            }
            // RR MOTOR
            if (message.mot_rr === "OK") {
                this.ico_rr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRR_green.png";
            }
            if (message.mot_rr === "WARM") {
                this.ico_rr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRR_orange.png";
            }
            if (message.mot_rr === "HOT") {
                this.ico_rr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRR_red.png";
            }
            if (message.mot_rr === "DISABLED") {
                this.ico_rr_motor_conf.src = "/assets/img/robot_icons/Nextion_ico_motorRR_grey.png";
            }

            /// POWER CONFIG MENU  ///
            // TEMP_PCB
            if (message.temp_int === "OK") {
                this.ico_temp_pcb_conf.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_green.png";
            }
            if (message.temp_int === "WARM") {
                this.ico_temp_pcb_conf.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_orange.png";
            }
            if (message.temp_int === "HOT") {
                this.ico_temp_pcb_conf.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_red.png";
            }
            if (message.temp_int === "DISABLED") {
                this.ico_temp_pcb_conf.src = "/assets/img/robot_icons/Nextion_ico_tempPCB_grey.png";
            }
            // FAN_PCB
            if (message.fan_int === "ON") {
                this.ico_fan_pcb_conf.src = "/assets/img/robot_icons/Nextion_ico_fanPCB_green.png";
            }
            else  {
                this.ico_fan_pcb_conf.src = "/assets/img/robot_icons/Nextion_ico_fanPCB_grey.png";
            }
            // TEMP_EXT
            if (message.temp_ext === "OK") {
                this.ico_temp_conf.src = "/assets/img/robot_icons/Nextion_ico_temp_green.png";
            }
            if (message.temp_ext === "WARM") {
                this.ico_temp_conf.src = "/assets/img/robot_icons/Nextion_ico_temp_orange.png";
            }
            if (message.temp_ext === "HOT") {
                this.ico_temp_conf.src = "/assets/img/robot_icons/Nextion_ico_temp_red.png";
            }
            if (message.temp_ext === "DISABLED") {
                this.ico_temp_conf.src = "/assets/img/robot_icons/Nextion_ico_temp_grey.png";
            }
            // FAN_EXT
            if (message.fan_ext === "ON") {
                this.ico_fan_conf.src = "/assets/img/robot_icons/Nextion_ico_fan_green.png";
            }
            else  {
                this.ico_fan_conf.src = "/assets/img/robot_icons/Nextion_ico_fan_grey.png";
            }
            // supply
            if (message.supply === "ONLINE") {
                this.ico_supply_conf.src = "/assets/img/robot_icons/Nextion_ico_supply_green.png";
            }
            else  {
                if (message.supply === "FAIL") {
                this.ico_supply_conf.src = "/assets/img/robot_icons/Nextion_ico_supply_red.png";
                }
                else  {
                    this.ico_supply_conf.src = "/assets/img/robot_icons/Nextion_ico_supply_grey.png";
                }
            }
            // BATTERY
            if (message.batt === "FULL") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_batt_full.png";
            }
            if (message.batt === "75") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_batt_34.png";
            }
            if (message.batt === "50") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_batt_half.png";
            }
            if (message.batt === "25") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_batt_14.png";
            }
            if (message.batt === "EMPTY") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_batt_empty.png";
            }
            if (message.batt === "FULL_CHARGE") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_full.png";
            }
            if (message.batt === "75_CHARGE") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_34.png";
            }
            if (message.batt === "50_CHARGE") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_half.png";
            }
            if (message.batt === "25_CHARGE") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_14.png";
            }
            if (message.batt === "EMPTY_CHARGE") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_battCHARGE_empty.png";
            }
            if (message.batt === "DISABLED") {
                this.ico_batt_conf.src = "/assets/img/robot_icons/Nextion_ico_batt_disabled.png";
            }
    }
}



class JoyTeleop {
    constructor(ros) {
        this.twist = new ROSLIB.Message({
            linear: {x: 0, y: 0, z: 0},
            angular: {x: 0,y: 0, z: 0}
        });
        this.cmdVel = new ROSLIB.Topic({
            ros: ros.ros,
            name: "/cmd_vel",
            messageType: "geometry_msgs/Twist"
        });
        this.publishImmidiately = true;
        this.lin = 0;
        this.ang = 0;
        this.publish_joy = false;
        this.joysize = 130;
        // this.speed_lin_fast = 0.75;
        // this.speed_ang_fast = 1.5;
        // this.speed_lin_moderate = 0.5;
        // this.speed_ang_moderate = 1.2;
        // this.speed_lin_low = 0.25;
        // this.speed_ang_low = 0.75;
        // this.speed_lin = this.speed_lin_moderate;
        // this.speed_ang = this.speed_ang_moderate;
        // this.joysize = 172;
        this.joystickContainer = document.getElementById("joy_view");
        this.options = {
            zone: this.joystickContainer,
            position: { left: 50 + "%", top: 50 + "%" },
            mode: "dynamic",
            //catchDistance: 1,
            size: this.joysize,
            color: "#0066ff",
            dynamicPage: true,
            //restJoystick: true
        };
        this.manager = nipplejs.create(this.options);
        this.pub_end_published = false;

        this.init();
    }

    init(){
        this.cmdVel.advertise();
    }

    moveAction(linear, angular) {
        if (linear !== undefined && angular !== undefined) {
            this.twist.linear.x = linear;
            this.twist.angular.z = angular;
        } else {
            this.twist.linear.x = 0;
            this.twist.angular.z = 0;
        }
        this.cmdVel.publish(this.twist);
    }

    joy_pub_speed(){
        if (this.publish_joy){
            this.moveAction(this.lin, this.ang);
            this.pub_end_published = false;
        }else{
            if (this.pub_end_published === false){
                this.moveAction(0, 0);
                this.pub_end_published = true;
            }
        }
    }

    set_lin(lin){
        this.lin = lin;
    }

    set_ang(ang){
        this.ang = ang;
    }

    set_publish_joy(publish_joy){
        this.publish_joy = publish_joy;
    }
}

class CameraView {

    constructor(ros) {
        this.width = 160;
        this.height = 120;
        this.topic = '/d435/color/image_raw';
        this.host = location.hostname;
        this.port = 8080;
        this._reload_cooldown = false; // prevents back-to-back reload storms
        this.camViewer = new MJPEGCANVAS.Viewer({
          divID : 'div_camera_view',
          host : this.host,
          port: this.port,
          type: 'mjpeg',
          // type: 'ros_compressed',
          quality: 20,
          refreshRate: 6,
          width : this.width,
          height : this.height,
          topic : this.topic,
        });
        var self = this;
        this._ros_was_disconnected = false; // true only after a real disconnect
        // CAMERA REWORK (2026-08-16, user request):
        //  * stream ONLY while the HUD camera view is shown (start()/stop());
        //    the page no longer opens the MJPEG connection at load
        //  * a loader overlay replaces the mjpegcanvas error icon while frames
        //    are not flowing yet
        //  * auto-resume after web_video_server / stack restarts (watchdog +
        //    rosconnected), and pause in a background tab
        this._active = false;
        this._buildLoader();
        this._attachImageHandlers();
        this.stop();                     // no streaming until the view is shown
        // 2026-08-16: click the view to ENLARGE / shrink (persisted). The
        // stream is restarted at the new size so the big view is sharp.
        this._big = false;   // the view ALWAYS opens small-at-the-bottom
        var _host0 = document.getElementById('div_camera_view');
        if (_host0) {
            _host0.style.cursor = 'zoom-in';
            _host0.title = 'Click to enlarge / shrink the camera view';
            _host0.addEventListener('click', function () { self.toggleSize(); });
        }
        // Watchdog (only while ACTIVE + tab visible): no frames -> loader +
        // reload. 3 s cadence reacts to a restarted web_video_server quickly
        // without hammering it.
        setInterval(function() {
            if (!self._active || document.hidden) return;
            if (!self.camViewer || !self.camViewer.image) return;
            if (self.camViewer.image.naturalWidth === 0) {
                self._showLoader();
                // forced: the cooldown must not starve recovery retries —
                // reloadStream now aborts the previous attempt's connection,
                // so a 3 s retry cadence is safe (no connection pile-up).
                self.reloadStream('watchdog', true);
            }
        }, 3000);
        // Fast first-frame poll: hide the loader the moment frames arrive.
        // Also self-heal a boot race: if the loader is up but the image src
        // never got the stream URL (early changeStream landed before the
        // canvas was ready), force a restart.
        setInterval(function() {
            if (!self._active || !self._loader || self._loader.style.display === 'none') return;
            var img = self.camViewer && self.camViewer.image;
            if (!img) return;
            if (img.naturalWidth > 0) { self._hideLoader(); return; }
            if ((img.src || '').indexOf(':' + self.port) < 0) {
                self.reloadStream('start-retry', true);
            }
        }, 300);
        // Background tab: closing the stream saves robot CPU/bandwidth; it
        // resumes automatically when the tab becomes visible again.
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                if (self._active) { try { self.camViewer.image.src = ''; } catch (e) {} }
            } else if (self._active) {
                self._showLoader();
                self.reloadStream('tab-visible', true);
            }
        });
        // Reload on reconnect ONLY when there was a real prior disconnect
        // (avoids the spurious reload on every fresh page load).
        document.addEventListener('rosdisconnected', function() {
            self._ros_was_disconnected = true;
        });
        document.addEventListener('rosconnected', function() {
            if (self._ros_was_disconnected) {
                self._ros_was_disconnected = false;
                if (self._active) {
                    self._showLoader();
                    setTimeout(function() { self.reloadStream('rosconnected', true); }, 2500);
                }
            }
        });
    }

    // ---- loader overlay (replaces the canvas error icon) -------------------
    _buildLoader() {
        var host = document.getElementById('div_camera_view');
        if (!host) return;
        // NOTE: the div is position:absolute (anchored bottom-left by inline
        // style) — do NOT touch its position; absolute children (the loader)
        // anchor to any positioned ancestor, absolute included.
        if (!document.getElementById('cam_loader_css')) {
            var st = document.createElement('style');
            st.id = 'cam_loader_css';
            st.textContent = '@keyframes camspin{to{transform:rotate(360deg)}}' +
                '.cam-loader{position:absolute;inset:0;display:flex;flex-direction:column;' +
                'align-items:center;justify-content:center;gap:6px;background:rgba(10,14,18,.85);' +
                'z-index:5;font-size:11px;color:#9fc9ff;}' +
                '.cam-loader .spin{width:22px;height:22px;border:3px solid rgba(159,201,255,.25);' +
                'border-top-color:#9fc9ff;border-radius:50%;animation:camspin .9s linear infinite;}';
            document.head.appendChild(st);
        }
        this._loader = document.createElement('div');
        this._loader.className = 'cam-loader';
        this._loader.style.display = 'none';
        this._loader.innerHTML = '<div class="spin"></div><div>camera…</div>';
        host.appendChild(this._loader);
    }
    _showLoader() { if (this._loader) this._loader.style.display = 'flex'; }
    _hideLoader() { if (this._loader) this._loader.style.display = 'none'; }

    // ---- lifecycle ---------------------------------------------------------
    start() {
        this._active = true;
        this._showLoader();
        this.reloadStream('start', true);
    }
    stop() {
        this._active = false;
        this._hideLoader();
        try { this.camViewer.image.src = ''; } catch (e) { /* not built yet */ }
    }

    _attachImageHandlers() {
        var self = this;
        if (!this.camViewer || !this.camViewer.image) return;
        this.camViewer.image.onerror = function() {
            if (!self._active) return;
            console.warn('[CameraView] stream error, retrying in 3s');
            self._showLoader();
            setTimeout(function() { self.reloadStream('onerror'); }, 3000);
        };
    }

    reloadStream(reason, force) {
        if (!this.camViewer || typeof this.camViewer.changeStream !== 'function') return;
        if (!this._active) return;               // stream only while shown
        if (document.hidden) return;
        if (this._reload_cooldown && !force) return; // already reloading, skip
        this._reload_cooldown = true;
        var self = this;
        setTimeout(function() { self._reload_cooldown = false; }, 6000);
        try {
            // changeStream() creates a brand-new Image each call and simply
            // ABANDONS the previous one — its open (or hanging) /stream
            // connection was never closed. During robot boot the stream
            // request hangs while web_video_server waits for the not-yet-
            // published camera topic, so every retry leaked one hung
            // connection; after ~6 the browser's per-host connection pool
            // was exhausted and the camera could never connect again, even
            // once the camera came up ("startuje dlouho a pak to nenaváže").
            // Abort the old stream FIRST (src='' cancels the fetch), then
            // open the fresh one, cache-busted so no URL-level cache can
            // serve it. onerror is detached before the abort so the ''
            // assignment can't schedule a spurious retry.
            var old = this.camViewer.image;
            if (old) { old.onerror = null; old.src = ''; }
            this.camViewer.changeStream(this.topic);
            var img = this.camViewer.image;   // the NEW Image made by changeStream
            if (img && (img.src || '').indexOf(':' + this.port) >= 0) {
                img.src = img.src + '&killcache=' + Date.now();
            }
            console.log('[CameraView] stream reload (' + reason + ')');
        } catch (e) {}
        this._attachImageHandlers();
    }

    toggleSize() {
        this._big = !this._big;   // runtime only — every SHOW resets to small
        this._applySize();
    }

    // Apply the small/large geometry + restart the stream at the matching
    // resolution (the MJPEG URL carries width/height, so the big view gets a
    // sharp stream instead of an upscaled 180px one).
    _applySize() {
        var host = document.getElementById('div_camera_view');
        if (!host) return;
        // small = 141x106: matches the log strip height (106 px) exactly —
        // the size the original layout settled on and the user expects.
        var w = 141, h = 106;
        if (this._big) {
            w = Math.min(Math.round(window.innerWidth * 0.6), 640);
            h = Math.round(w * 0.75);
        }
        this.camViewer.width = w;
        this.camViewer.height = h;
        // big view: full JPEG quality tier (the small HUD view stays at the
        // bandwidth-friendly 20) — this is what makes the enlarged stream
        // actually sharp, on top of the width/height URL params.
        this.camViewer.quality = this._big ? 60 : 20;
        if (this._big) {
            // BIG view (user request v2): LEFT side, sitting right ABOVE the
            // log strip (log top edge = 35 + 106 px -> bottom 149 with a
            // small gap). Grows upward from there.
            host.style.position = 'fixed';
            host.style.left = '4px';
            host.style.transform = '';
            host.style.top = 'auto';
            host.style.bottom = '149px';
            host.style.marginTop = '0px';
            host.style.marginLeft = '0px';
        } else if (!this._smallAnchor) {
            // Field-verified bottom-left corner next to the log view. Measuring
            // the legacy flow position proved unreliable (it collapses after a
            // big-mode round-trip and reads zero while hidden) — the designed
            // spot is a constant, so pin it as one.
            this._smallAnchor = { left: 4, bottom: 35 };
        }
        if (!this._big && this._smallAnchor) {
            host.style.position = 'fixed';
            host.style.left = this._smallAnchor.left + 'px';
            host.style.bottom = this._smallAnchor.bottom + 'px';
            host.style.top = 'auto';
            host.style.transform = '';
            host.style.marginTop = '0px';
            host.style.marginLeft = '0px';
        }
        host.style.width = w + 'px';
        host.style.height = h + 'px';
        host.style.cursor = this._big ? 'zoom-out' : 'zoom-in';
        try { this.changeViewerSize_cam_view(); } catch (e) { /* hidden */ }
        if (this._active) {
            this._showLoader();
            this.reloadStream('resize', true);
        }
    }

    calculateAspectRatioFit(srcWidth, srcHeight, maxWidth, maxHeight) {
        var ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight);
        return { width: Math.round(srcWidth*ratio), height: Math.round(srcHeight*ratio) };
     }

    changeViewerSize_cam_view(){
        const width_el = document.getElementById("div_camera_view").clientWidth;
        const height_el = document.getElementById("div_camera_view").clientHeight;
        const padding_el = parseInt((document.getElementById("div_camera_view").style.padding).replace('px', ''));
        const border_el = parseInt((document.getElementById("div_camera_view").style.border).replace('px', ''));
        this.camViewer.width = width_el - (padding_el*2);
        this.camViewer.height = height_el - (padding_el*2);
        const canvas_size = this.calculateAspectRatioFit(this.width, this.height, this.camViewer.width, this.camViewer.height);
        const content = document.getElementById('div_camera_view');
        content.firstChild.width = canvas_size.width;
        content.firstChild.height = canvas_size.height;
        content.style.width = Math.round(canvas_size.width + (border_el*2) + (padding_el*2)) + 'px';
        content.style.height = Math.round(canvas_size.height + (border_el*2) + (padding_el*2)) + 'px';
    };
}


class LidarControl {
    constructor(ros) {
        this.btn_menu_lidar_on = document.getElementById("btn_menu_lidar_on");
        this.btn_menu_lidar_off = document.getElementById("btn_menu_lidar_off");
        this.btngroup_lidar_on_off = document.getElementById("btngroup_lidar_on_off");
        this.stop_lidar_srvs = new ROSLIB.Service({
            ros : ros,
            name : '/stop_motor',
            serviceType : 'std_srvs/EmptyRequest'
        });
        this.start_lidar_srvs = new ROSLIB.Service({
            ros : ros,
            name : '/start_motor',
            serviceType : 'std_srvs/EmptyRequest'
        });
        this.request = new ROSLIB.ServiceRequest({});
        this.icon_status_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/device_state_pub/icon_status',
            messageType: 'vitulus_msgs/Device_icon_status'
        });
    }
    stop_lidar(){
        this.stop_lidar_srvs.callService(this.request, function(result) {
            console.log('Result for service call on stop lidar: ' + result);
        }, function(error){
            console.error("Got an error while trying to call stop lidar service");
        });
    }
    start_lidar(){
        this.start_lidar_srvs.callService(this.request, function(result) {
            console.log('Result for service call on start lidar: ' + result);
        }, function(error){
            console.error("Got an error while trying to call start lidar service");
        });
    }
    status_data(message){
        if (message.lidar === "ON") {
            this.btngroup_lidar_on_off.style.setProperty('border', '2px solid var(--bs-success)');
        }
        else {
            this.btngroup_lidar_on_off.style.setProperty('border', '2px solid var(--bs-danger)');
        }
    }
}


class MotorControl {
    constructor(ros) {
        this.btn_motor_torque = document.getElementById("btn_motor_torque");
        this.input_motor_torque = document.getElementById("input_motor_torque");
        this.span_motor1_status = document.getElementById("span_motor1_status");
        this.span_motor1_torque = document.getElementById("span_motor1_torque");
        this.span_motor1_temp = document.getElementById("span_motor1_temp");
        this.span_motor1_velocity = document.getElementById("span_motor1_velocity");
        this.span_motor1_position = document.getElementById("span_motor1_position");
        this.span_motor1_volts = document.getElementById("span_motor1_volts");
        this.span_motor1_mode = document.getElementById("span_motor1_mode");
        this.span_motor1_id = document.getElementById("span_motor1_id");
        this.span_motor2_status = document.getElementById("span_motor2_status");
        this.span_motor2_torque = document.getElementById("span_motor2_torque");
        this.span_motor2_temp = document.getElementById("span_motor2_temp");
        this.span_motor2_velocity = document.getElementById("span_motor2_velocity");
        this.span_motor2_position = document.getElementById("span_motor2_position");
        this.span_motor2_volts = document.getElementById("span_motor2_volts");
        this.span_motor2_mode = document.getElementById("span_motor2_mode");
        this.span_motor2_id = document.getElementById("span_motor2_id");
        this.span_motor3_status = document.getElementById("span_motor3_status");
        this.span_motor3_torque = document.getElementById("span_motor3_torque");
        this.span_motor3_temp = document.getElementById("span_motor3_temp");
        this.span_motor3_velocity = document.getElementById("span_motor3_velocity");
        this.span_motor3_position = document.getElementById("span_motor3_position");
        this.span_motor3_volts = document.getElementById("span_motor3_volts");
        this.span_motor3_mode = document.getElementById("span_motor3_mode");
        this.span_motor3_id = document.getElementById("span_motor3_id");
        this.span_motor4_status = document.getElementById("span_motor4_status");
        this.span_motor4_torque = document.getElementById("span_motor4_torque");
        this.span_motor4_temp = document.getElementById("span_motor4_temp");
        this.span_motor4_velocity = document.getElementById("span_motor4_velocity");
        this.span_motor4_position = document.getElementById("span_motor4_position");
        this.span_motor4_volts = document.getElementById("span_motor4_volts");
        this.span_motor4_mode = document.getElementById("span_motor4_mode");
        this.span_motor4_id = document.getElementById("span_motor4_id");
        this.span_motor_torque = document.getElementById("span_motor_torque");
        this.btn_motors_on = document.getElementById("btn_motors_on");
        this.btn_motors_off = document.getElementById("btn_motors_off");
        this.btngroup_motors_on_off = document.getElementById("btngroup_motors_on_off");


        // this.joy_teleop = joy_teleop_arg;
        // this.move_base_control = move_base_control_arg;

        this.motorPowerTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/base/motor_power',
            messageType : 'std_msgs/Bool'
        });
        this.motorPowerStateTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/base/motor_power_state',
            messageType : 'std_msgs/Bool'
        });
        this.pmMotorSwitchTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/set_motor_switch',
            messageType : 'std_msgs/Bool'
        });
        this.motor_power_msg = new ROSLIB.Message({
            data : false
        });
        this.pm_motor_switch_msg = new ROSLIB.Message({
            data : false
        });
        this.front_left_wheel_state_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/base/front_left_wheel_state',
            messageType: 'vitulus_msgs/Moteus_controller_state'
        });
        this.rear_left_wheel_state_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/base/rear_left_wheel_state',
            messageType: 'vitulus_msgs/Moteus_controller_state'
        });
        this.front_right_wheel_state_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/base/front_right_wheel_state',
            messageType: 'vitulus_msgs/Moteus_controller_state'
        });
        this.rear_right_wheel_state_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/base/rear_right_wheel_state',
            messageType: 'vitulus_msgs/Moteus_controller_state'
        });
        this.get_torque_set_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/base/get_torque_set',
            messageType: 'std_msgs/Float32'
        });
        this.set_torque_topic = new ROSLIB.Topic({
            ros : ros,
            name : '/base/set_torque',
            messageType : 'std_msgs/Float32'
        });

        this.init();
    }

    init(){
        this.motorPowerTopic.advertise();
        this.pmMotorSwitchTopic.advertise();
        this.set_torque_topic.advertise();
    }

    motor_state_data(message){
        if (message.data){
            this.btngroup_motors_on_off.style.setProperty('border', '2px solid var(--bs-success)');
        }
        else {
            this.btngroup_motors_on_off.style.setProperty('border', '2px solid var(--bs-danger)');
        }
    }

    motor1_data(message){
        this.span_motor1_status.textContent = message.fault;
        if (message.fault === "OK") {
            this.span_motor1_status.className = 'text-success';
        }else {
            this.span_motor1_status.className = 'text-danger';
        }
        this.span_motor1_torque.textContent = message.torque.toFixed(2);
        let torque_color = 'text-success';
        if (Math.abs(message.torque) >= 10){
            torque_color = 'text-warning';
        }
        if (Math.abs(message.torque) >= 15){
            torque_color = 'text-danger';
        }
        this.span_motor1_torque.className = torque_color;
        this.span_motor1_temp.textContent = message.temperature;
        let temp_color = 'text-success';
        if (message.temperature >= 50){
            temp_color = 'text-warning';
        }
        if (message.temperature >= 60){
            temp_color = 'text-danger';
        }
        this.span_motor1_temp.className = temp_color;
        this.span_motor1_velocity.textContent = message.velocity.toFixed(2);
        this.span_motor1_position.textContent = message.position.toFixed(2);
        this.span_motor1_volts.textContent = message.voltage;
        this.span_motor1_mode.textContent = message.mode;
        if (message.mode === "POSITION") {
            this.span_motor1_mode.className = 'text-success';
        }else {
            this.span_motor1_mode.className = 'text-danger';
        }
        this.span_motor1_id.textContent = message.id;
    }
    motor2_data(message){
        this.span_motor2_status.textContent = message.fault;
        if (message.fault === "OK") {
            this.span_motor2_status.className = 'text-success';
        }else {
            this.span_motor2_status.className = 'text-danger';
        }
        this.span_motor2_torque.textContent = message.torque.toFixed(2);
        let torque_color = 'text-success';
        if (Math.abs(message.torque) >= 10){
            torque_color = 'text-warning';
        }
        if (Math.abs(message.torque) >= 15){
            torque_color = 'text-danger';
        }
        this.span_motor2_torque.className = torque_color;
        this.span_motor2_temp.textContent = message.temperature;
        let temp_color = 'text-success';
        if (message.temperature >= 50){
            temp_color = 'text-warning';
        }
        if (message.temperature >= 60){
            temp_color = 'text-danger';
        }
        this.span_motor2_temp.className = temp_color;
        this.span_motor2_velocity.textContent = message.velocity.toFixed(2);
        this.span_motor2_position.textContent = message.position.toFixed(2);
        this.span_motor2_volts.textContent = message.voltage;
        this.span_motor2_mode.textContent = message.mode;
        if (message.mode === "POSITION") {
            this.span_motor2_mode.className = 'text-success';
        }else {
            this.span_motor2_mode.className = 'text-danger';
        }
        this.span_motor2_id.textContent = message.id;
    }
    motor3_data(message){
        this.span_motor3_status.textContent = message.fault;
        if (message.fault === "OK") {
            this.span_motor3_status.className = 'text-success';
        }else {
            this.span_motor3_status.className = 'text-danger';
        }
        this.span_motor3_torque.textContent = message.torque.toFixed(2);
        let torque_color = 'text-success';
        if (Math.abs(message.torque) >= 10){
            torque_color = 'text-warning';
        }
        if (Math.abs(message.torque) >= 15){
            torque_color = 'text-danger';
        }
        this.span_motor3_torque.className = torque_color;
        this.span_motor3_temp.textContent = message.temperature;
        let temp_color = 'text-success';
        if (message.temperature >= 50){
            temp_color = 'text-warning';
        }
        if (message.temperature >= 60){
            temp_color = 'text-danger';
        }
        this.span_motor3_temp.className = temp_color;
        this.span_motor3_velocity.textContent = message.velocity.toFixed(2);
        this.span_motor3_position.textContent = message.position.toFixed(2);
        this.span_motor3_volts.textContent = message.voltage;
        this.span_motor3_mode.textContent = message.mode;
        if (message.mode === "POSITION") {
            this.span_motor3_mode.className = 'text-success';
        }else {
            this.span_motor3_mode.className = 'text-danger';
        }
        this.span_motor3_id.textContent = message.id;
    }
    motor4_data(message){
        this.span_motor4_status.textContent = message.fault;
        if (message.fault === "OK") {
            this.span_motor4_status.className = 'text-success';
        }else {
            this.span_motor4_status.className = 'text-danger';
        }
        this.span_motor4_torque.textContent = message.torque.toFixed(2);
        let torque_color = 'text-success';
        if (Math.abs(message.torque) >= 10){
            torque_color = 'text-warning';
        }
        if (Math.abs(message.torque) >= 15){
            torque_color = 'text-danger';
        }
        this.span_motor4_torque.className = torque_color;
        this.span_motor4_temp.textContent = message.temperature;
        let temp_color = 'text-success';
        if (message.temperature >= 50){
            temp_color = 'text-warning';
        }
        if (message.temperature >= 60){
            temp_color = 'text-danger';
        }
        this.span_motor4_temp.className = temp_color;
        this.span_motor4_velocity.textContent = message.velocity.toFixed(2);
        this.span_motor4_position.textContent = message.position.toFixed(2);
        this.span_motor4_volts.textContent = message.voltage;
        this.span_motor4_mode.textContent = message.mode;
        if (message.mode === "POSITION") {
            this.span_motor4_mode.className = 'text-success';
        }else {
            this.span_motor4_mode.className = 'text-danger';
        }
        this.span_motor4_id.textContent = message.id;
    }

    pub_set_torque(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_torque_topic.publish(msg);
    }

    motors_on(){
        this.motor_power_msg.data = true;
        this.pm_motor_switch_msg.data = true;
        // this.pmMotorSwitchTopic.publish(this.pm_motor_switch_msg);
        this.motorPowerTopic.publish(this.motor_power_msg);
    }
    motors_off(){
        this.motor_power_msg.data = false;
        this.pm_motor_switch_msg.data = false;
        // this.pmMotorSwitchTopic.publish(this.pm_motor_switch_msg);
        this.motorPowerTopic.publish(this.motor_power_msg);
    }
    btn_motors_on_onclick(motors_control, status) {
        if (status === true) {
            motors_control.motors_on();
        }
        else {
            motors_control.motors_off();
        }
    }

}


class MapMenu {
    constructor(ros, maps, status_bar) {
        this.maps = maps;
        // this.rtabmap = rtabmap;
        this.status_bar = status_bar;
        this.map_to_show = 'planner';
        this.row_submenu = document.getElementById("row_submenu");
        this.row_submenu_visible = false;
        this.row_submenu.style.display = "none";

        this.current_submenu = 'none';

        this.div_menu_marker = document.getElementById("div_menu_marker");
        this.div_menu_marker.style.display = "none";
        this.btn_marker = document.getElementById("btn_marker");
        this.btn_marker.active = false;
        this.btn_marker_send_goal = document.getElementById("btn_marker_send_goal");
        this.range_marker_orientation = document.getElementById("range_marker_orientation");
        this.btn_marker_cancel_navigation = document.getElementById("btn_marker_cancel_navigation");
        this.span_menu_rtabmap_distance_apply = document.getElementById("span_menu_rtabmap_distance_apply");

        this.div_menu_config = document.getElementById("div_menu_config");
        this.div_menu_config.style.display = "none";
        this.btn_settings = document.getElementById("btn_settings");
        this.btn_settings.active = false;

        this.btn_menu_lidar_on = document.getElementById("btn_menu_lidar_on");
        this.btn_menu_lidar_off = document.getElementById("btn_menu_lidar_off");
        this.btn_menu_rtabmap_camera = document.getElementById("btn_menu_rtabmap_camera");
        this.btn_menu_rtabmap_lidar = document.getElementById("btn_menu_rtabmap_lidar");
        this.btn_menu_rtabmap_both = document.getElementById("btn_menu_rtabmap_both");
        this.input_range_rtabmap_distance = document.getElementById("input_range_rtabmap_distance");
        this.span_rtabmap_distance = document.getElementById("span_rtabmap_distance");
        this.rtabmap_sensor = 0;


        this.btn_menu_joy_show = document.getElementById("btn_menu_joy_show");
        this.btn_menu_joy_hide = document.getElementById("btn_menu_joy_hide");

        this.btn_map = document.getElementById("btn_map");
        this.div_menu_map = document.getElementById("div_menu_map");
        this.div_menu_map.style.display = "none";
        this.btn_menu_map_new_indoor = document.getElementById("btn_menu_map_new_indoor");
        this.btn_menu_map_new_outdoor = document.getElementById("btn_menu_map_new_outdoor");

        this.btn_menu_map_new_save = document.getElementById("btn_menu_map_new_save");
        this.input_menu_map_new = document.getElementById("input_menu_map_new");
        this.div_menu_map_items_row = document.getElementById("div_menu_map_items_row");
        this.div_menu_map_items_row.innerHTML = '';
        this.btn_menu_map_planner_show = document.getElementById("btn_menu_map_planner_show");
        this.btn_menu_map_rtabmap_show = document.getElementById("btn_menu_map_rtabmap_show");

        // this.btn_points = document.getElementById("btn_points_map");
        this.div_menu_map_point = document.getElementById("div_menu_map_point");
        this.div_menu_point_items_row = document.getElementById("div_menu_point_items_row");
        this.div_menu_point_items_row.innerHTML = '';
        this.btn_menu_point_new_save = document.getElementById("btn_menu_point_new_save");
        this.input_menu_point_new = document.getElementById("input_menu_point_new");
        this.btn_menu_point_clear = document.getElementById("btn_menu_point_clear");
        this.btn_menu_point_cancel = document.getElementById("btn_menu_point_cancel");

        // this.btn_paths = document.getElementById("btn_paths_map");
        this.div_menu_map_path = document.getElementById("div_menu_map_path");
        this.div_menu_path_items_row = document.getElementById("div_menu_path_items_row");
        this.div_menu_path_items_row.innerHTML = '';
        this.btn_menu_path_new_save = document.getElementById("btn_menu_path_new_save");
        this.input_menu_path_new = document.getElementById("input_menu_path_new");
        this.btn_menu_path_clear = document.getElementById("btn_menu_path_clear");
        this.btn_menu_path_cancel = document.getElementById("btn_menu_path_cancel");
        this.btn_menu_path_auto = document.getElementById("btn_menu_path_new_auto");
        this.btn_menu_path_stop_auto = document.getElementById("btn_menu_path_stop_auto");

        this.btn_programs = document.getElementById("btn_programs");
        this.div_menu_map_program = document.getElementById("div_menu_map_program");
        this.div_menu_program_detail_row = document.getElementById("div_menu_program_detail_row");
        this.div_menu_program_detail_row.style.display = 'none';
        this.div_menu_program_items_row = document.getElementById("div_menu_program_items_row");
        this.div_menu_program_items_row.innerHTML = '';
        this.span_menu_program_name = document.getElementById("span_menu_program_name");
        this.span_menu_program_length = document.getElementById("span_menu_program_length");
        this.span_menu_program_area = document.getElementById("span_menu_program_area");
        this.span_menu_program_duration = document.getElementById("span_menu_program_duration");
        this.btn_menu_program_show = document.getElementById("btn_menu_program_show");
        this.btn_menu_program_run = document.getElementById("btn_menu_program_run");
        this.span_menu_program_map = document.getElementById("span_menu_program_map");
        this.span_menu_program_env = document.getElementById("span_menu_program_env");
        this.row_menu_program_detail_zones = document.getElementById("row_menu_program_detail_zones");
        this.btn_menu_program_stop = document.getElementById("btn_menu_program_stop");
        this.btn_menu_program_reset = document.getElementById("btn_menu_program_reset");
        this.span_menu_program_status = document.getElementById("span_menu_program_status");
        this.btn_menu_program_resume = document.getElementById("btn_menu_program_resume");
        this.span_menu_program_last_result = document.getElementById("span_menu_program_last_result");
        this.inp_program_rpm = document.getElementById("inp_program_rpm");
        this.inp_program_cut_height = document.getElementById("inp_program_cut_height");
        this.inp_program_name = document.getElementById("inp_program_name");
        this.btn_program_speed_slow = document.getElementById("btn_program_speed_slow");
        this.btn_program_speed_mid = document.getElementById("btn_program_speed_mid");
        this.btn_program_speed_fast = document.getElementById("btn_program_speed_fast");
        this.chk_program_override_zone = document.getElementById("chk_program_override_zone");
        this.btn_program_save_settings = document.getElementById("btn_program_save_settings");

        this.btn_joy = document.getElementById("btn_joy");
        this.joy_view = document.getElementById("joy_view");
        this.joy_view.style.display = "none";

        this.btn_camera_show = document.getElementById("btn_camera_show");
        this.div_camera_view = document.getElementById("div_camera_view");
        this.div_camera_view.style.display = "none";

        this.btn_follow = document.getElementById("btn_follow");

        this.btn_log = document.getElementById("btn_log");
        this.div_log_view = document.getElementById("div_log_view");
        this.div_log_view.style.display = "none";

        this.btn_stop_all = document.getElementById("btn_stop_all");

        this.dock_pose_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/nav_tf/set_dock_pose',
            messageType : 'std_msgs/Bool'
        });
        this.cancel_navi_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/smach_goal/cancel',
            messageType : 'std_msgs/Bool'
        });
        this.new_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/new_map',
            messageType : 'std_msgs/String'
        });
        this.new_map_msg = new ROSLIB.Message({
            data : ''
        });
        this.save_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/save_map',
            messageType : 'std_msgs/String'
        });
        this.map_list_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/map_str_list',
            messageType : 'vitulus_msgs/StringList'
        });
        this.load_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/load_map',
            messageType : 'std_msgs/String'
        });
        this.load_map_rtabmap_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/load_map_rtabmap',
            messageType : 'std_msgs/String'
        });
        this.remove_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/remove_map',
            messageType : 'std_msgs/String'
        });
        this.new_point_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/save_waypoint',
            messageType : 'std_msgs/String'
        });
        this.publish_point_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/publish_point',
            messageType : 'std_msgs/String'
        });
        this.send_point_goal_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/goal_point',
            messageType : 'std_msgs/String'
        });
        this.remove_point_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/remove_point',
            messageType : 'std_msgs/String'
        });
        this.new_path_auto_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/start_new_autopath',
            messageType : 'std_msgs/String'
        });
        this.path_stop_auto_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/stop_autopath',
            messageType : 'std_msgs/Bool'
        });
        this.new_path_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/save_path',
            messageType : 'std_msgs/String'
        });
        this.new_path_point_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/save_path_point',
            messageType : 'std_msgs/String'
        });
        this.publish_path_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/publish_path',
            messageType : 'std_msgs/String'
        });
        this.remove_path_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/remove_path',
            messageType : 'std_msgs/String'
        });
        this.execute_path_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/execute_path',
            messageType : 'std_msgs/String'
        });
        this.show_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/show_map',
            messageType : 'std_msgs/String'
        });
        this.map_source_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/map_source',
            messageType : 'std_msgs/String'
        });
        this.rtabmap_settings_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/rtabmap_settings',
            messageType : 'vitulus_msgs/Rtabmap_settings'
        });
        this.rtabmap_settings_set_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/rtabmap_settings_set',
            messageType : 'vitulus_msgs/Rtabmap_settings'
        });
        this.map_source_Topic.subscribe((message) => {
            this.map_btns_state(message);
        });
        this.rtabmap_settings_Topic.subscribe((message) => {
            this.rtabmap_settings_btns_state(message);
        });

        this.init();
    }

    init(){
        this.new_map_Topic.advertise();
        this.save_map_Topic.advertise();
        this.load_map_Topic.advertise();
        this.load_map_rtabmap_Topic.advertise();
        this.remove_map_Topic.advertise();
        this.new_point_Topic.advertise();
        this.publish_point_Topic.advertise();
        this.send_point_goal_Topic.advertise();
        this.remove_point_Topic.advertise();
        this.new_path_Topic.advertise();
        this.new_path_point_Topic.advertise();
        this.new_path_auto_Topic.advertise();
        this.path_stop_auto_Topic.advertise();
        this.publish_path_Topic.advertise();
        this.remove_path_Topic.advertise();
        this.execute_path_Topic.advertise();
        this.show_map_Topic.advertise();
        this.cancel_navi_Topic.advertise();
        this.dock_pose_Topic.advertise();
        this.rtabmap_settings_set_Topic.advertise();
        if (this.status_bar.is_indoor === true){
            this.map_to_show = 'rtabmap';
        }
        else {
            this.map_to_show = 'planner';
        }
    }

    cancel_goal_publish(){
        // console.log("cancel_goal_publish");
        const msg = new ROSLIB.Message({
            data : true,
        });
        this.cancel_navi_Topic.publish(msg);
    }

    dock_pose_publish(){
        const msg = new ROSLIB.Message({
            data : true,
        });
        this.dock_pose_Topic.publish(msg);
    }

    rtabmap_apply(){
        const msg = new ROSLIB.Message({
            grid_sensor: parseInt(this.rtabmap_sensor),
            grid_sensor_distance: parseFloat(this.span_menu_rtabmap_distance_apply.textContent),
        });
        this.rtabmap_settings_set_Topic.publish(msg);
    }

    map_btns_state(msg){
        if (msg.data === 'planner'){
            this.btn_menu_map_planner_show.style.color = "#446de5";
            this.btn_menu_map_rtabmap_show.style.color = "#ffffff";
        }
        if (msg.data === 'rtabmap'){
            this.btn_menu_map_planner_show.style.color = "#ffffff";
            this.btn_menu_map_rtabmap_show.style.color = "#446de5";
        }
    }

    rtabmap_settings_btns_state(msg){
        if (msg.grid_sensor === 0) {
            this.btn_menu_rtabmap_lidar.style.color = "#446de5";
            this.btn_menu_rtabmap_camera.style.color = "#ffffff";
            this.btn_menu_rtabmap_both.style.color = "#ffffff";
        }
        if (msg.grid_sensor === 1) {
            this.btn_menu_rtabmap_lidar.style.color = "#ffffff";
            this.btn_menu_rtabmap_camera.style.color = "#446de5";
            this.btn_menu_rtabmap_both.style.color = "#ffffff";
        }
        if (msg.grid_sensor === 2) {
            this.btn_menu_rtabmap_lidar.style.color = "#ffffff";
            this.btn_menu_rtabmap_camera.style.color = "#ffffff";
            this.btn_menu_rtabmap_both.style.color = "#446de5";
        }
        this.span_rtabmap_distance.textContent = Math.round(msg.grid_sensor_distance * 100) / 100;
    }



    show_rtabmap_map() {
        this.show_map_Topic.publish(new ROSLIB.Message({data: 'rtabmap'}));
    }
    show_planner_map() {
        this.show_map_Topic.publish(new ROSLIB.Message({data: 'planner'}));
    }

    path_clicked_exec(name){
        // console.log("execute_path: " + name);
        this.execute_path_Topic.publish(new ROSLIB.Message({
            data: name,
        }));
    }
    show_modal_remove_path(name){
        document.getElementById("span_modal_remove_path_name").innerHTML = name;
        $('#btn_modal_remove_path').attr('onclick', 'map_menu.remove_path("' + name + '")');
        $('#modal_remove_path').modal('show');
    }
    remove_path(name){
        // console.log("remove_path: " + name);
        this.remove_path_Topic.publish(new ROSLIB.Message({
            data: name,
        }));
        $('#modal_remove_path').modal('hide');
    }
    path_clicked_show(name){
        // console.log("publish_path: " + name);
        this.publish_path_Topic.publish(new ROSLIB.Message({
            data: name,
        }));
    }
    add_path_point(path_name){
        const msg = new ROSLIB.Message({
            data : path_name,
        });
        this.new_path_point_Topic.publish(msg);
    }
    save_path(){
        const msg = new ROSLIB.Message({
            data : this.input_menu_path_new.value,
        });
        this.new_path_Topic.publish(msg);
        this.input_menu_path_new.value = '';
    }
    new_auto_path(){
        const msg = new ROSLIB.Message({
            data : this.input_menu_path_new.value,
        });
        this.new_path_auto_Topic.publish(msg);
        this.input_menu_path_new.value = '';
    }
    stop_auto_path(){
        const msg = new ROSLIB.Message({
            data : true,
        });
        this.path_stop_auto_Topic.publish(msg);
        this.input_menu_path_new.value = '';
    }

    show_modal_remove_point(name){
        document.getElementById("span_modal_remove_point_name").innerHTML = name;
        $('#btn_modal_remove_point').attr('onclick', 'map_menu.remove_point("' + name + '")');
        $('#modal_remove_point').modal('show');
    }
    save_point(){
        const msg = new ROSLIB.Message({
            data : this.input_menu_point_new.value,
        });
        this.new_point_Topic.publish(msg);
        this.input_menu_point_new.value = '';
    }
    remove_point(name){
        // console.log("remove_point: " + name);
        this.remove_point_Topic.publish(new ROSLIB.Message({
            data: name,
        }));
        $('#modal_remove_point').modal('hide');
    }
    point_clicked_show(name){
        // console.log("publish_point: " + name);
        this.publish_point_Topic.publish(new ROSLIB.Message({
            data: name,
        }));
    }
    point_clicked_goal(name){
        // console.log("send_point_goal: " + name);
        this.send_point_goal_Topic.publish(new ROSLIB.Message({
            data: name,
        }));
    }

    show_modal_remove_map(map_name, map_filename){
        document.getElementById("span_modal_remove_map_name").innerHTML = map_name;
        $('#btn_modal_remove_map').attr('onclick', 'map_menu.remove_map("' + map_filename + '")');
        $('#modal_remove_map').modal('show');
    }

    remove_map(map_filename){
        // console.log("remove_map: " + map_filename);
        this.remove_map_Topic.publish(new ROSLIB.Message({
            data: map_filename,
        }));
        $('#modal_remove_map').modal('hide');
    }

    load_clicked_map(map_name, type){
        // console.log("load_clicked_map: " + map_name);
        if (type === 'INDOOR') {
            this.load_map_rtabmap_Topic.publish(new ROSLIB.Message({
                data: map_name,
            }));
        }
        if (type === 'OUTDOOR') {
            this.load_map_Topic.publish(new ROSLIB.Message({
                data: map_name,
            }));
        }
    }

    process_map_list(message){
        let map_elements = "";
        message.string_list.forEach(async (map) => {
            const items = map.split('***env*');
            const map_name = items[0];
            const items2 = items[1].split(' (');
            const map_type = items2[0];
            const map_size = items2[1].replace(' GB)', '');
            const tmpl = new MapListItemTemplate(map_name, map_type, map_size);
            map_elements += tmpl.element;
        });
        this.div_menu_map_items_row.innerHTML = map_elements;
    }

    save_map(){
        const save_map_Msg = new ROSLIB.Message({
            data : this.input_menu_map_new.value,
        });
        this.save_map_Topic.publish(save_map_Msg);
    }

    new_map(map_type){
        this.new_map_msg.data = map_type;
        this.new_map_Topic.publish(this.new_map_msg);
    }

    joy_show(){
        if (this.joy_view.style.display === "none"){
            this.joy_view.style.display = "block";
            this.btn_joy.active = true;
        } else {
            this.joy_view.style.display = "none";
            this.btn_joy.active = false;
        }
        uiPrefSet('vitulus_hud_joy', this.btn_joy.active ? '1' : '0');
    }

    camera_show(camera_view){
        if (this.div_camera_view.style.display === "none"){
            this.div_camera_view.style.display = "block";
            this.btn_camera_show.active = true;
            camera_view._big = false;    // showing ALWAYS starts small+bottom
            camera_view._applySize();
            camera_view.start();     // 2026-08-16: stream starts only now
        } else {
            this.div_camera_view.style.display = "none";
            this.btn_camera_show.active = false;
            camera_view.stop();      // hidden -> stop streaming entirely
        }
        uiPrefSet('vitulus_hud_camera', this.btn_camera_show.active ? '1' : '0');
    }

    // ----- Phase 1 left slide-out drawer -----------------------------------
    // Move the existing menu panels (+ the map editor) into the drawer body ONCE
    // and wire the drawer's own close affordance. The panels keep their IDs and
    // all their (ID-scoped) bindings survive the DOM move.
    install_drawer() {
        this.ui_drawer = document.getElementById("ui_drawer");
        this.ui_drawer_body = document.getElementById("ui_drawer_body");
        this.ui_drawer_title = document.getElementById("ui_drawer_title");
        this.ui_drawer_backdrop = document.getElementById("ui_drawer_backdrop");
        this._drawer_titles = {
            marker: 'Marker', map: 'Map', program: 'Programs',
            config: 'Settings', editor: 'Map editor',
        };
        this._drawer_last = null;
        if (!this.ui_drawer || !this.ui_drawer_body) return;
        var self = this;
        ['div_menu_marker', 'div_menu_map', 'div_menu_map_program',
         'div_menu_config', 'div_map_detail'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) self.ui_drawer_body.appendChild(el);   // move (not copy)
        });
        var xb = document.getElementById("btn_ui_drawer_close");
        if (xb) xb.onclick = function () { self.close_drawer(); };
        if (this.ui_drawer_backdrop) this.ui_drawer_backdrop.onclick = function () { self.close_drawer(); };
        var fb = document.getElementById("btn_ui_drawer_full");
        if (fb) fb.onclick = function () { self.toggle_drawer_full(); };
    }

    // ----- Fullscreen-expand toggle (per-panel persisted) ------------------
    // Adds/removes .full on #ui_drawer (wins over .wide, width:100vw). State is
    // remembered per panel key in localStorage so e.g. Programs can stay expanded
    // while Marker stays normal-width.
    set_drawer_full(on) {
        if (this.ui_drawer) {
            if (on) this.ui_drawer.classList.add('full');
            else this.ui_drawer.classList.remove('full');
        }
        var key = this._drawer_last;
        if (key) {
            try { localStorage.setItem('vitulus_drawer_full_' + key, on ? '1' : '0'); } catch (e) {}
        }
        this._update_drawer_full_buttons(on);
    }

    toggle_drawer_full() {
        var on = !(this.ui_drawer && this.ui_drawer.classList.contains('full'));
        this.set_drawer_full(on);
    }

    _update_drawer_full_buttons(on) {
        var icon = on ? 'la-compress' : 'la-expand';
        var title = on ? 'Restore' : 'Expand';
        ['btn_ui_drawer_full', 'btn_map_detail_full'].forEach(function (id) {
            var b = document.getElementById(id);
            if (!b) return;
            b.title = title;
            b.setAttribute('aria-label', title);
            var i = b.querySelector('i');
            if (i) { i.classList.remove('la-expand', 'la-compress'); i.classList.add(icon); }
        });
    }

    _drawer_backdrop(on) {
        if (!this.ui_drawer_backdrop) return;
        var mobile = window.innerWidth < 576;
        this.ui_drawer_backdrop.style.display = (on && mobile) ? 'block' : 'none';
    }

    // Slide the drawer IN and show the chrome/title for `key`.
    open_drawer(key) {
        this._drawer_last = key;
        // Remember which panel is open so a reload restores it ('editor' is
        // deliberately NOT restored at boot — see the restore block in init).
        uiPrefSet('vitulus_open_panel', key);
        // Anchor the drawer just under the always-visible trigger button row
        // (#row_menu) so those buttons stay clickable to switch/close panels.
        try {
            var rm = document.getElementById('row_menu');
            if (rm && this.ui_drawer) {
                var b = rm.getBoundingClientRect().bottom;
                if (b > 0) this.ui_drawer.style.top = Math.round(b + 2) + 'px';
            }
        } catch (e) {}
        if (this.ui_drawer) {
            this.ui_drawer.classList.add('open');
            if (key === 'program') this.ui_drawer.classList.add('wide');
            else this.ui_drawer.classList.remove('wide');
            if (key === 'editor') this.ui_drawer.classList.add('editor');
            else this.ui_drawer.classList.remove('editor');
            this.ui_drawer.setAttribute('aria-hidden', 'false');
        }
        if (this.ui_drawer_title) this.ui_drawer_title.textContent = (this._drawer_titles[key] || '');
        if (this.ui_drawer_body) this.ui_drawer_body.scrollTop = 0;
        this._drawer_backdrop(true);
        // Restore this panel's remembered fullscreen-expand state.
        var remembered_full = false;
        try { remembered_full = localStorage.getItem('vitulus_drawer_full_' + key) === '1'; } catch (e) {}
        this.set_drawer_full(remembered_full);
    }

    // Slide the drawer OUT (used by the per-button toggle-off path; panel already
    // hidden by the caller).
    _drawer_slide_out() {
        if (this.ui_drawer) {
            this.ui_drawer.classList.remove('open', 'wide', 'editor', 'full');
            this.ui_drawer.setAttribute('aria-hidden', 'true');
        }
        this._drawer_backdrop(false);
        uiPrefDel('vitulus_open_panel');   // closed -> nothing to restore
    }

    // Full close: hide every panel (also exits the map editor) and slide out.
    // Used by the drawer chrome ✕, the backdrop tap, and the editor ✕.
    close_drawer() {
        this.hide_all_submenu_divs();
        this._drawer_slide_out();
        this.current_submenu = 'none';
        this.row_submenu_visible = false;
        if (this.btn_marker) this.btn_marker.active = false;
        if (this.btn_map) this.btn_map.active = false;
        if (this.btn_settings) this.btn_settings.active = false;
        if (this.btn_programs) this.btn_programs.active = false;
    }

    // Force-show the Map panel in the drawer (used when leaving the editor back to
    // the Map panel it was launched from).
    show_map_panel() {
        this.hide_all_submenu_divs();
        this.current_submenu = 'map';
        this.div_menu_map.style.display = "block";
        this.row_submenu_visible = true;
        this.btn_map.active = true;
        this.open_drawer('map');
    }

    // Show the map-editor panel in the drawer (called by MapEditor.showDetail()).
    // The editor's #div_map_detail is shown by MapEditor itself; here we just hide
    // the sibling menu panels and drive the drawer chrome/state.
    open_drawer_editor() {
        this.div_menu_marker.style.display = "none";
        this.div_menu_config.style.display = "none";
        this.div_menu_map.style.display = "none";
        this.div_menu_map_point.style.display = "none";
        this.div_menu_map_path.style.display = "none";
        this.div_menu_map_program.style.display = "none";
        this.current_submenu = 'editor';
        this.row_submenu_visible = true;
        if (this.btn_marker) this.btn_marker.active = false;
        if (this.btn_map) this.btn_map.active = false;
        if (this.btn_settings) this.btn_settings.active = false;
        if (this.btn_programs) this.btn_programs.active = false;
        this.open_drawer('editor');
    }

    hide_all_submenu_divs() {
        this.div_menu_marker.style.display = "none";
        this.div_menu_config.style.display = "none";
        this.div_menu_map.style.display = "none";
        this.div_menu_map_point.style.display = "none";
        this.div_menu_map_path.style.display = "none";
        this.div_menu_map_program.style.display = "none";
        // vitulus_ui: also close the in-view map editor (restores the live camera
        // + map) so opening any other menu panel cleanly leaves edit mode.
        var dme = document.getElementById("div_menu_mapedit");
        if (dme) dme.style.display = "none";
        try { if (window.MapEditor && window.MapEditor.exitIfActive) window.MapEditor.exitIfActive(); } catch (e) {}
        // vitulus_ui: settings menu (with the IMU tab) is now hidden — let app.js
        // stop the IMU ros3d render loop if it was running.
        try { if (window.__syncImuRender) window.__syncImuRender(); } catch (e) {}
        this.row_submenu_visible = false;
    }

    // btn_points_onclick(interactive_markers) {
    //     if (this.current_submenu !== 'points') {
    //         this.hide_all_submenu_divs();
    //         this.row_submenu.style.display = "none";
    //         this.row_submenu_visible = false;
    //         interactive_markers.imClient.rootObject.visible = false;
    //     }
    //     if (this.row_submenu_visible === false) {
    //         this.current_submenu = 'points';
    //         this.div_menu_map_point.style.display = "block";
    //         this.row_submenu.style.display = "block";
    //         this.row_submenu_visible = true;
    //         this.btn_points.active = true;
    //     }
    //     else {
    //         this.current_submenu = 'none';
    //         this.div_menu_map_point.style.display = "none";
    //         this.row_submenu.style.display = "none";
    //         this.row_submenu_visible = false;
    //         this.btn_points.active = false;
    //     }
    // }

    // btn_paths_onclick(interactive_markers) {
    //     if (this.current_submenu !== 'path') {
    //         this.hide_all_submenu_divs();
    //         this.row_submenu.style.display = "none";
    //         this.row_submenu_visible = false;
    //         interactive_markers.imClient.rootObject.visible = false;
    //     }
    //     if (this.row_submenu_visible === false) {
    //         this.current_submenu = 'path';
    //         this.div_menu_map_path.style.display = "block";
    //         this.row_submenu.style.display = "block";
    //         this.row_submenu_visible = true;
    //         this.btn_paths.active = true;
    //     }
    //     else {
    //         this.current_submenu = 'none';
    //         this.div_menu_map_path.style.display = "none";
    //         this.row_submenu.style.display = "none";
    //         this.row_submenu_visible = false;
    //         this.btn_paths.active = false;
    //     }
    // }

    btn_programs_onclick(interactive_markers) {
        if (this.current_submenu !== 'program') {
            this.hide_all_submenu_divs();
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            interactive_markers.imClient.rootObject.visible = false;
        }
        if (this.row_submenu_visible === false) {
            this.current_submenu = 'program';
            this.div_menu_map_program.style.display = "block";
            this.row_submenu.style.display = "block";
            this.row_submenu_visible = true;
            this.btn_programs.active = true;
            this.open_drawer('program');
        }
        else {
            this.current_submenu = 'none';
            this.div_menu_map_program.style.display = "none";
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            this.btn_programs.active = false;
            this._drawer_slide_out();
        }
    }

    btn_map_onclick(interactive_markers) {
        if (this.current_submenu !== 'map') {
            this.hide_all_submenu_divs();
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            interactive_markers.imClient.rootObject.visible = false;
        }
        if (this.row_submenu_visible === false) {
            this.current_submenu = 'map';
            this.div_menu_map.style.display = "block";
            this.row_submenu.style.display = "block";
            this.row_submenu_visible = true;
            this.btn_map.active = true;
            this.open_drawer('map');
        }
        else {
            this.current_submenu = 'none';
            this.div_menu_map.style.display = "none";
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            this.btn_map.active = false;
            this._drawer_slide_out();
            // NOTE: the map-detail/editor panel is independent of the Map menu —
            // closing the menu leaves it open (so you can edit with more map
            // visible). It is closed via its own ✕ / the edit toggle, or when
            // switching to a different menu (hide_all_submenu_divs).
        }
    }

    btn_config_onclick(interactive_markers) {
        if (this.current_submenu !== 'config') {
            this.hide_all_submenu_divs();
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            interactive_markers.imClient.rootObject.visible = false;
        }
        if (this.row_submenu_visible === false) {
            this.current_submenu = 'config';
            this.div_menu_config.style.display = "block";
            this.row_submenu.style.display = "block";
            this.row_submenu_visible = true;
            this.btn_settings.active = true;
            this.open_drawer('config');
        }
        else {
            this.current_submenu = 'none';
            this.div_menu_config.style.display = "none";
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            this.btn_settings.active = false;
            this._drawer_slide_out();
        }
        // vitulus_ui: start/stop the IMU ros3d render loop depending on whether
        // the settings menu (which now hosts the IMU tab) is open + IMU tab active.
        try { if (window.__syncImuRender) window.__syncImuRender(); } catch (e) {}
    }


    btn_marker_onclick(interactive_markers) {
        if (this.current_submenu !== 'marker') {
            this.hide_all_submenu_divs();
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
        }
        if (this.row_submenu_visible === false) {
            this.current_submenu = 'marker';
            this.div_menu_marker.style.display = "block";
            this.row_submenu.style.display = "block";
            this.row_submenu_visible = true;
            this.btn_marker.active = true;
            interactive_markers.imClient.rootObject.visible = true;
            this.open_drawer('marker');
        }
        else {
            this.current_submenu = 'none';
            this.div_menu_marker.style.display = "none";
            this.row_submenu.style.display = "none";
            this.row_submenu_visible = false;
            this.btn_marker.active = false;
            interactive_markers.imClient.rootObject.visible = false;
            this._drawer_slide_out();
        }
    }
    btn_marker_send_goal_onclick(interactive_markers) {
        interactive_markers.send_goal();
        // this.btn_marker_onclick(interactive_markers);
    }

    btn_menu_lidar_on_onclick(lidar_control, status) {
        if (status === true) {
            lidar_control.start_lidar();
        }
        else {
            lidar_control.stop_lidar();
        }
    }
}

class RosLog{
    constructor(ros) {
        this.LOG_COMPACT = 60;       // entries kept in the compact strip
        this.LOG_BUFFER  = 1500;     // entries kept in memory for the expanded view
        this.LEVELS = {1: 'DEBUG', 2: 'INFO', 4: 'WARN', 8: 'ERROR', 16: 'FATAL'};
        this.buffer = [];
        this.sources = new Set();
        this.filters = {
            // by default hide DEBUG noise
            levels: new Set([2, 4, 8, 16]),
            sources: new Set(),
            search: ''
        };
        // settings-persistence: restore level / node-source / search filters.
        try {
            var lv = uiPrefGet('vitulus_log_levels', null);
            if (lv !== null) {
                this.filters.levels = new Set(
                    lv.split(',').map(function (s) { return parseInt(s, 10); })
                      .filter(function (n) { return [1, 2, 4, 8, 16].indexOf(n) !== -1; }));
            }
            var src = JSON.parse(uiPrefGet('vitulus_log_sources', '[]'));
            if (Array.isArray(src)) { this.filters.sources = new Set(src); }
            this.filters.search = uiPrefGet('vitulus_log_search', '').toLowerCase();
        } catch (e) { /* malformed stored value — keep defaults */ }
        this.expanded = false;
        this.active = true;          // whether this view currently owns the shared DOM
        this.autoscroll = true;
        this.viewEl = null;
        this.contentEl = null;
        this.toolbarEl = null;
        this.expandBtn = null;
        this.collapseBtn = null;
        this.sourceToggleBtn = null;
        this.sourcePanelEl   = null;
        this.sourceListEl    = null;
        this._source_cb_map  = new Map();
        this.searchInput = null;
        this.counterEl = null;
        this.pauseBtn = null;
        this.pendingAppend = [];
        this.scheduled = false;
        this.shownCount = 0;
        this.suppressScrollEvent = false;
        this.log_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/rosout_agg',
            messageType: 'rosgraph_msgs/Log'
        });
    }

    attach(viewEl) {
        this.viewEl = viewEl;
        this.contentEl   = viewEl.querySelector('#div_log_content');
        this.toolbarEl   = viewEl.querySelector('#div_log_toolbar');
        this.expandBtn   = viewEl.querySelector('#btn_log_expand');
        this.collapseBtn = viewEl.querySelector('#btn_log_collapse');
        this.sourceToggleBtn = viewEl.querySelector('#btn_log_source_toggle');
        this.sourcePanelEl   = viewEl.querySelector('#div_log_source_panel');
        this.sourceListEl    = viewEl.querySelector('#div_log_source_list');
        const srcAllBtn      = viewEl.querySelector('#btn_log_src_all');
        this.searchInput  = viewEl.querySelector('#input_log_search');
        this.counterEl    = viewEl.querySelector('#span_log_counter');
        this.pauseBtn     = viewEl.querySelector('#btn_log_pause');

        // Level filter buttons (multi-toggle)
        viewEl.querySelectorAll('.log-level-group [data-level]').forEach((btn) => {
            const lvl = parseInt(btn.dataset.level, 10);
            if (this.filters.levels.has(lvl)) btn.classList.add('active');
            else btn.classList.remove('active');
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (this.filters.levels.has(lvl)) {
                    this.filters.levels.delete(lvl);
                    btn.classList.remove('active');
                } else {
                    this.filters.levels.add(lvl);
                    btn.classList.add('active');
                }
                uiPrefSet('vitulus_log_levels', Array.from(this.filters.levels).join(','));
                if (this.expanded) this.render_full();
            });
        });

        this.sourceToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = this.sourcePanelEl.style.display !== 'none';
            this.sourcePanelEl.style.display = open ? 'none' : 'flex';
        });
        srcAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.filters.sources.clear();
            uiPrefSet('vitulus_log_sources', '[]');
            this._source_cb_map.forEach(cb => { cb.checked = false; });
            this._update_source_label();
            if (this.expanded) this.render_full();
        });
        document.addEventListener('click', (e) => {
            if (this.sourcePanelEl && this.sourcePanelEl.style.display !== 'none') {
                const wrap = viewEl.querySelector('.log-source-filter');
                if (wrap && !wrap.contains(e.target)) {
                    this.sourcePanelEl.style.display = 'none';
                }
            }
        }, { passive: true });

        // settings-persistence: reflect the restored search text + node-filter
        // label into the controls.
        if (this.filters.search) { this.searchInput.value = this.filters.search; }
        this._update_source_label();

        let searchTimer = null;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                this.filters.search = this.searchInput.value.trim().toLowerCase();
                uiPrefSet('vitulus_log_search', this.filters.search);
                if (this.expanded) this.render_full();
            }, 150);
        });

        // Shared controls (clear / pause / expand / collapse / scroll-autoscroll)
        // are wired by LogPanel so they operate on whichever view is active.
    }

    clear() {
        this.buffer.length = 0;
        if (this.contentEl) this.contentEl.innerHTML = '';
        this.shownCount = 0;
        this.update_counter();
    }

    _set_autoscroll(on) {
        this.autoscroll = !!on;
        if (!this.pauseBtn) return;
        const span = this.pauseBtn.querySelector('span');
        if (this.autoscroll) {
            this.pauseBtn.classList.add('btn-outline-info');
            this.pauseBtn.classList.remove('btn-info');
            if (span) span.textContent = 'Live';
            this.pauseBtn.title = 'Pause autoscroll';
        } else {
            this.pauseBtn.classList.remove('btn-outline-info');
            this.pauseBtn.classList.add('btn-info');
            if (span) span.textContent = 'Paused';
            this.pauseBtn.title = 'Resume autoscroll';
        }
    }

    set_expanded(on) {
        this.expanded = !!on;
        if (this.expanded) {
            this.viewEl.classList.add('log-expanded');
            this.viewEl.classList.remove('log-compact');
            this._set_autoscroll(true);
            this.render_full();
        } else {
            this.viewEl.classList.remove('log-expanded');
            this.viewEl.classList.add('log-compact');
            this._set_autoscroll(true);
            this.render_compact();
            // re-trigger layout so the strip is positioned again
            if (typeof layout_man !== 'undefined' && layout_man) layout_man.set_layout();
        }
        this.scroll_to_bottom();
    }

    matches(entry) {
        if (!this.filters.levels.has(entry.level)) return false;
        if (this.filters.sources.size > 0 && !this.filters.sources.has(entry.name)) return false;
        if (this.filters.search) {
            const s = this.filters.search;
            if (entry.msg.toLowerCase().indexOf(s) === -1 && entry.name.toLowerCase().indexOf(s) === -1) return false;
        }
        return true;
    }

    format_line(entry) {
        const span = document.createElement('span');
        span.className = 'log-line lvl-' + entry.level;
        const t = new Date(entry.t * 1000);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        const meta = document.createElement('span');
        meta.className = 'log-meta';
        meta.textContent = '[' + (this.LEVELS[entry.level] || '?') + '] ' + hh + ':' + mm + ':' + ss + ' ';
        const name = document.createElement('span');
        name.className = 'log-name';
        name.textContent = '[' + entry.name + '] ';
        span.appendChild(meta);
        span.appendChild(name);
        span.appendChild(document.createTextNode(entry.msg));
        return span;
    }

    process_message(message) {
        const entry = {
            level: message.level,
            name:  message.name,
            msg:   message.msg,
            t:     message.header.stamp.secs
        };
        this.buffer.push(entry);
        if (this.buffer.length > this.LOG_BUFFER) this.buffer.shift();

        if (!this.sources.has(entry.name)) {
            this.sources.add(entry.name);
            this.update_source_list();
        }

        if (this.active) {
            if (this.expanded) {
                if (this.matches(entry)) {
                    this.pendingAppend.push(entry);
                    this.schedule_append();
                }
            } else if (this.viewEl && this.viewEl.style.display === 'block') {
                // compact strip — keep original simple behaviour (all levels visible)
                this.append_compact(entry);
            }
            this.update_counter();
        }
    }

    schedule_append() {
        if (this.scheduled) return;
        this.scheduled = true;
        const fn = () => {
            this.scheduled = false;
            if (!this.pendingAppend.length) return;
            const frag = document.createDocumentFragment();
            for (const e of this.pendingAppend) frag.appendChild(this.format_line(e));
            this.shownCount += this.pendingAppend.length;
            this.pendingAppend.length = 0;
            this.contentEl.appendChild(frag);
            // Cap DOM nodes to keep things snappy
            while (this.contentEl.childElementCount > this.LOG_BUFFER) {
                this.contentEl.removeChild(this.contentEl.firstChild);
                this.shownCount = Math.max(0, this.shownCount - 1);
            }
            this.update_counter();
            if (this.autoscroll) this.scroll_to_bottom();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
        else setTimeout(fn, 16);
    }

    append_compact(entry) {
        const el = this.contentEl;
        el.appendChild(this.format_line(entry));
        while (el.childElementCount > this.LOG_COMPACT) el.removeChild(el.firstChild);
        this.suppressScrollEvent = true;
        el.scrollTop = el.scrollHeight;
        this.suppressScrollEvent = false;
    }

    render_compact() {
        if (!this.contentEl) return;
        const el = this.contentEl;
        el.innerHTML = '';
        const start = Math.max(0, this.buffer.length - this.LOG_COMPACT);
        const frag = document.createDocumentFragment();
        for (let i = start; i < this.buffer.length; i++) frag.appendChild(this.format_line(this.buffer[i]));
        el.appendChild(frag);
        this.shownCount = el.childElementCount;
        this.update_counter();
        this.suppressScrollEvent = true;
        el.scrollTop = el.scrollHeight;
        this.suppressScrollEvent = false;
    }

    render_full() {
        if (!this.contentEl) return;
        const el = this.contentEl;
        el.innerHTML = '';
        const frag = document.createDocumentFragment();
        let shown = 0;
        for (const entry of this.buffer) {
            if (this.matches(entry)) {
                frag.appendChild(this.format_line(entry));
                shown++;
            }
        }
        el.appendChild(frag);
        this.shownCount = shown;
        this.pendingAppend.length = 0;
        this.update_counter();
        this.suppressScrollEvent = true;
        el.scrollTop = el.scrollHeight;
        this.suppressScrollEvent = false;
    }

    update_source_list() {
        if (!this.sourceListEl) return;
        const sorted = Array.from(this.sources).sort();
        for (const n of sorted) {
            if (this._source_cb_map.has(n)) continue;
            const lbl = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this.filters.sources.has(n);
            cb.addEventListener('change', () => {
                if (cb.checked) this.filters.sources.add(n);
                else this.filters.sources.delete(n);
                uiPrefSet('vitulus_log_sources',
                    JSON.stringify(Array.from(this.filters.sources)));
                this._update_source_label();
                if (this.expanded) this.render_full();
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode('\u00a0' + n));
            this.sourceListEl.appendChild(lbl);
            this._source_cb_map.set(n, cb);
        }
    }

    _update_source_label() {
        if (!this.sourceToggleBtn) return;
        const count = this.filters.sources.size;
        if (count === 0) {
            this.sourceToggleBtn.textContent = 'All nodes \u25be';
        } else if (count === 1) {
            const name = Array.from(this.filters.sources)[0];
            const short = name.length > 18 ? name.slice(0, 17) + '\u2026' : name;
            this.sourceToggleBtn.textContent = short + ' \u25be';
        } else {
            this.sourceToggleBtn.textContent = count + '\u00a0nodes \u25be';
        }
    }

    update_counter() {
        if (!this.counterEl) return;
        if (this.expanded) this.counterEl.textContent = this.shownCount + ' / ' + this.buffer.length;
        else this.counterEl.textContent = String(this.buffer.length);
    }

    scroll_to_bottom() {
        if (!this.contentEl) return;
        this.suppressScrollEvent = true;
        this.contentEl.scrollTop = this.contentEl.scrollHeight;
        this.suppressScrollEvent = false;
    }
}


// Main robot event feed.  The former "Status" tab was only another log: every
// /nextion/log_info line, no meaning, no priority.  This feed turns the same
// durable history into CHANGES and adds the agent's own reports plus browser ↔
// ROS connection changes.  Raw /rosout remains one click away for diagnosis.
function robotEventText(value) {
    var text = String(value == null ? '' : value)
        .replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 220) text = text.slice(0, 219) + '…';   // 219 + ellipsis = 220
    return text;
}

function robotEventClassify(value, hintedSource) {
    var msg = robotEventText(value);
    var n = msg.toLowerCase();
    var severity = 'info';
    if (/(fault|fatal|chyba|error|ztratil.{0,20}sign[aá]l|lost.{0,20}signal|fix lost|bez spojení|odpojen|disconnected|timeout|nouz)/i.test(n)) {
        severity = 'critical';
    } else if (/(warning|varov|slab|degrad|nedostup|unavailable|blocked|čeká na schválení|ztrác)/i.test(n)) {
        severity = 'warning';
    } else if (/(obnoven|recovered|connected|připojen|dokončen|hotovo|docked|v doku|nabito|charged|fix získán|fix acquired)/i.test(n)) {
        severity = 'good';
    }
    var source = hintedSource || 'Robot';
    if (!hintedSource) {
        if (/(rtk|gnss|gps|fix|satelit)/i.test(n)) source = 'Poloha';
        else if (/(lidar|laser|scan)/i.test(n)) source = 'Lidar';
        else if (/(motor|moteus|pohon)/i.test(n)) source = 'Pohon';
        else if (/(dock|dok|nabíj|charger)/i.test(n)) source = 'Dok';
        else if (/(navig|trasa|waypoint|cíl|goal)/i.test(n)) source = 'Navigace';
        else if (/(kamera|camera|realsense)/i.test(n)) source = 'Kamera';
        else if (/(bater|battery|napájen|power)/i.test(n)) source = 'Napájení';
        else if (/(signal|spojení|connection|wifi|síť)/i.test(n)) source = 'Spojení';
    }
    return {msg: msg, source: source, severity: severity,
            signature: source + '|' + msg.toLowerCase()};
}

class StatusLog {
    constructor(ros) {
        this.LOG_COMPACT = 30;
        this.LOG_BUFFER  = 1500;
        this.buffer = [];
        this.lastSeq = -1;
        this.agentCursor = 0;
        this.lastBySource = new Map();
        this.active = false;
        this.expanded = false;
        this.autoscroll = true;
        this.viewEl = null;
        this.contentEl = null;
        this.counterEl = null;
        this.pauseBtn = null;
        this.shownCount = 0;
        this.pendingAppend = [];
        this.scheduled = false;
        this.suppressScrollEvent = false;
        this.history_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/status_logger/history',
            messageType: 'std_msgs/String'
        });
        this.ros = ros && ros.ros;
    }

    attach(viewEl) {
        this.viewEl = viewEl;
        this.contentEl = viewEl.querySelector('#div_log_content');
        this.counterEl = viewEl.querySelector('#span_log_counter');
        this.pauseBtn  = viewEl.querySelector('#btn_log_pause');
    }

    subscribe() {
        this.history_topic.subscribe((message) => this.process_history(message));
        if (this.ros && this.ros.on) {
            this.ros.on('connection', () => this.ingest({
                t: Date.now() / 1000, msg: 'Spojení s robotem obnoveno', source: 'Spojení'}));
            this.ros.on('close', () => this.ingest({
                t: Date.now() / 1000, msg: 'Ztratil se signál z robota', source: 'Spojení'}));
            this.ros.on('error', () => this.ingest({
                t: Date.now() / 1000, msg: 'Chyba spojení s robotem', source: 'Spojení'}));
        }
        this.poll_agent();
    }

    poll_agent() {
        var url = 'http://' + location.hostname + ':8088/api/tasks?since_id=' + this.agentCursor;
        fetch(url, {cache: 'no-store'}).then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        }).then((payload) => {
            var tasks = (payload && payload.tasks) || [];
            tasks.forEach((task) => {
                if (task.id > this.agentCursor) this.agentCursor = task.id;
                if (task.source !== 'agent' && task.state !== 'failed') return;
                var text = task.reply || task.text || '';
                if (!text) return;
                this.ingest({seq: 'agent:' + task.id,
                             t: task.reply_ts || task.ts || Date.now() / 1000,
                             msg: text, source: 'Agent'});
            });
        }).catch(() => {}).finally(() => {
            window.setTimeout(() => this.poll_agent(), 5000);
        });
    }

    process_history(message) {
        let arr;
        try { arr = JSON.parse(message.data); } catch (e) { return; }
        if (!Array.isArray(arr)) return;

        // Detect a logger restart/reset (seq numbers went backwards) and rebuild.
        let maxSeq = -1;
        for (const e of arr) if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
        if (arr.length && maxSeq < this.lastSeq) {
            this.buffer.length = 0;
            this.lastSeq = -1;
            this.shownCount = 0;
            this.pendingAppend.length = 0;
            this.lastBySource.clear();
            if (this.active && this.contentEl) this.contentEl.innerHTML = '';
        }

        let added = 0;
        for (const e of arr) {
            const seq = (typeof e.seq === 'number') ? e.seq : null;
            if (seq !== null && seq <= this.lastSeq) continue;
            if (seq !== null) this.lastSeq = Math.max(this.lastSeq, seq);
            if (this.ingest({seq: seq, t: e.t, msg: e.msg})) added++;
        }
        if (added && this.active) {
            if (this.expanded) this.schedule_append();
            this.update_counter();
        }
    }

    ingest(raw) {
        var classified = robotEventClassify(raw.msg, raw.source);
        if (!classified.msg) return false;
        var t = Number(raw.t) || Date.now() / 1000;
        var previous = this.lastBySource.get(classified.source);
        // A status publisher often repeats the same state every tick.  The feed
        // describes changes, so repeats are noise — but lost→recovered→lost is
        // three real transitions and must not be hidden by an old signature.
        if (previous && previous.signature === classified.signature &&
                Math.abs(t - previous.t) < 60) return false;
        var entry = {seq: raw.seq, t: t, msg: classified.msg,
                     source: classified.source, severity: classified.severity,
                     signature: classified.signature};

        // Flapping inputs (notably GNSS acquired/lost at 2 Hz) used to consume
        // the whole visible strip.  Keep one changing row per source during a
        // five-second burst; once stable for longer, the next change is a new
        // event with its own timestamp.
        var replace = previous && Math.abs(entry.t - previous.t) < 5;
        if (replace && previous.index >= 0 && previous.index < this.buffer.length) {
            this.buffer[previous.index] = entry;
            this.lastBySource.set(entry.source, {t: entry.t, index: previous.index,
                                                  signature: entry.signature});
            if (this.active && this.contentEl) {
                this.pendingAppend.length = 0;
                if (this.expanded) this.render_full(); else this.render_compact();
            }
            return true;
        }
        this.buffer.push(entry);
        if (this.buffer.length > this.LOG_BUFFER) {
            this.buffer.shift();
            this.lastBySource.forEach((value, key) => {
                if (value.index <= 0) this.lastBySource.delete(key);
                else value.index -= 1;
            });
        }
        this.lastBySource.set(entry.source,
                              {t: entry.t, index: this.buffer.length - 1,
                               signature: entry.signature});
        if (this.active) {
            if (this.expanded) this.pendingAppend.push(entry);
            else if (this.viewEl && this.viewEl.style.display === 'block') this.append_compact(entry);
            this.update_counter();
        }
        return true;
    }

    format_line(entry) {
        const span = document.createElement('span');
        span.className = 'log-line status event-' + (entry.severity || 'info');
        const t = entry.t ? new Date(entry.t * 1000) : new Date();
        const p = (n) => String(n).padStart(2, '0');
        if (this.expanded) {
            const d = document.createElement('span');
            d.className = 'log-date';
            d.textContent = t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ';
            span.appendChild(d);
        }
        const meta = document.createElement('span');
        meta.className = 'log-meta';
        meta.textContent = p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + ' ';
        span.appendChild(meta);
        const dot = document.createElement('span');
        dot.className = 'event-dot';
        dot.textContent = '●';
        span.appendChild(dot);
        const source = document.createElement('span');
        source.className = 'event-source';
        source.textContent = (entry.source || 'Robot') + ' · ';
        span.appendChild(source);
        span.appendChild(document.createTextNode(entry.msg));
        span.title = t.toLocaleString();
        return span;
    }

    append_compact(entry) {
        const el = this.contentEl;
        el.appendChild(this.format_line(entry));
        while (el.childElementCount > this.LOG_COMPACT) el.removeChild(el.firstChild);
        this.suppressScrollEvent = true;
        el.scrollTop = el.scrollHeight;
        this.suppressScrollEvent = false;
    }

    schedule_append() {
        if (this.scheduled) return;
        this.scheduled = true;
        const fn = () => {
            this.scheduled = false;
            if (!this.pendingAppend.length) return;
            const frag = document.createDocumentFragment();
            for (const e of this.pendingAppend) frag.appendChild(this.format_line(e));
            this.shownCount += this.pendingAppend.length;
            this.pendingAppend.length = 0;
            this.contentEl.appendChild(frag);
            while (this.contentEl.childElementCount > this.LOG_BUFFER) {
                this.contentEl.removeChild(this.contentEl.firstChild);
                this.shownCount = Math.max(0, this.shownCount - 1);
            }
            this.update_counter();
            if (this.autoscroll) this.scroll_to_bottom();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
        else setTimeout(fn, 16);
    }

    render_compact() {
        if (!this.contentEl) return;
        const el = this.contentEl;
        el.innerHTML = '';
        const start = Math.max(0, this.buffer.length - this.LOG_COMPACT);
        const frag = document.createDocumentFragment();
        for (let i = start; i < this.buffer.length; i++) frag.appendChild(this.format_line(this.buffer[i]));
        el.appendChild(frag);
        this.shownCount = el.childElementCount;
        this.update_counter();
        this.suppressScrollEvent = true;
        el.scrollTop = el.scrollHeight;
        this.suppressScrollEvent = false;
    }

    render_full() {
        if (!this.contentEl) return;
        const el = this.contentEl;
        el.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const entry of this.buffer) frag.appendChild(this.format_line(entry));
        el.appendChild(frag);
        this.shownCount = this.buffer.length;
        this.pendingAppend.length = 0;
        this.update_counter();
        this.suppressScrollEvent = true;
        el.scrollTop = el.scrollHeight;
        this.suppressScrollEvent = false;
    }

    update_counter() {
        if (!this.counterEl) return;
        if (this.expanded) this.counterEl.textContent = this.shownCount + ' / ' + this.buffer.length;
        else this.counterEl.textContent = String(this.buffer.length);
    }

    clear() {
        this.buffer.length = 0;
        this.lastSeq = -1;
        this.lastBySource.clear();
        if (this.contentEl) this.contentEl.innerHTML = '';
        this.shownCount = 0;
        this.update_counter();
    }

    _set_autoscroll(on) {
        this.autoscroll = !!on;
        if (!this.pauseBtn) return;
        const span = this.pauseBtn.querySelector('span');
        if (this.autoscroll) {
            this.pauseBtn.classList.add('btn-outline-info');
            this.pauseBtn.classList.remove('btn-info');
            if (span) span.textContent = 'Live';
            this.pauseBtn.title = 'Pause autoscroll';
        } else {
            this.pauseBtn.classList.remove('btn-outline-info');
            this.pauseBtn.classList.add('btn-info');
            if (span) span.textContent = 'Paused';
            this.pauseBtn.title = 'Resume autoscroll';
        }
    }

    set_expanded(on) {
        this.expanded = !!on;
        if (this.expanded) {
            this.viewEl.classList.add('log-expanded');
            this.viewEl.classList.remove('log-compact');
            this._set_autoscroll(true);
            this.render_full();
        } else {
            this.viewEl.classList.remove('log-expanded');
            this.viewEl.classList.add('log-compact');
            this._set_autoscroll(true);
            this.render_compact();
            if (typeof layout_man !== 'undefined' && layout_man) layout_man.set_layout();
        }
        this.scroll_to_bottom();
    }

    scroll_to_bottom() {
        if (!this.contentEl) return;
        this.suppressScrollEvent = true;
        this.contentEl.scrollTop = this.contentEl.scrollHeight;
        this.suppressScrollEvent = false;
    }
}


// Coordinates the two bottom-log views (RosLog = /rosout, StatusLog = cached
// status messages) over a single shared toolbar + content area. Owns the
// controls that act on whichever view is currently selected.
class LogPanel {
    constructor(ros) {
        this.rosLog = new RosLog(ros);
        this.statusLog = new StatusLog(ros);
        // The most visible strip is for useful robot changes. Raw ROS is a
        // diagnostic opt-in, not the default thing an owner has to decipher.
        var firstEventFeed = uiPrefGet('vitulus_event_feed_v1', '0') !== '1';
        this.mode = firstEventFeed ? 'status'
            : (uiPrefGet('vitulus_log_mode', 'status') === 'rosout'
               ? 'rosout' : 'status');
        if (firstEventFeed) {
            uiPrefSet('vitulus_event_feed_v1', '1');
            uiPrefSet('vitulus_log_mode', 'status');
        }
        this.expanded = false;
        this.viewEl = null;
        this.contentEl = null;
        this.rosoutOnlyEls = [];
        this.modeBtns = [];
    }

    get active() { return this.mode === 'status' ? this.statusLog : this.rosLog; }

    attach(viewEl) {
        this.viewEl = viewEl;
        this.rosLog.attach(viewEl);
        this.statusLog.attach(viewEl);
        this.rosLog.active = this.mode === 'rosout';
        this.statusLog.active = this.mode === 'status';

        this.contentEl   = viewEl.querySelector('#div_log_content');
        const pauseBtn    = viewEl.querySelector('#btn_log_pause');
        const clearBtn    = viewEl.querySelector('#btn_log_clear');
        const expandBtn   = viewEl.querySelector('#btn_log_expand');
        const collapseBtn = viewEl.querySelector('#btn_log_collapse');
        this.rosoutOnlyEls = Array.from(viewEl.querySelectorAll('.log-rosout-only'));
        this.modeBtns      = Array.from(viewEl.querySelectorAll('.log-mode-group [data-logmode]'));

        this.modeBtns.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.set_mode(btn.dataset.logmode);
            });
        });

        pauseBtn.addEventListener('click', () => {
            const a = this.active;
            a._set_autoscroll(!a.autoscroll);
            if (a.autoscroll) a.scroll_to_bottom();
        });
        clearBtn.addEventListener('click', () => { this.active.clear(); });
        // settings-persistence: expanded is saved only on these explicit
        // clicks (NOT inside set_expanded), so the hide-log path collapsing
        // the view doesn't overwrite the remembered preference.
        expandBtn.addEventListener('click', (e) => {
            e.stopPropagation(); this.set_expanded(true);
            uiPrefSet('vitulus_log_expanded', '1');
        });
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation(); this.set_expanded(false);
            uiPrefSet('vitulus_log_expanded', '0');
        });

        // settings-persistence: constructor restored the remembered mode;
        // apply its controls even though set_mode would short-circuit.
        this._apply_mode_visibility();

        this.contentEl.addEventListener('scroll', () => {
            const a = this.active;
            if (a.suppressScrollEvent) return;
            const el = this.contentEl;
            const atBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 16;
            if (!atBottom && a.autoscroll) a._set_autoscroll(false);
            else if (atBottom && !a.autoscroll) a._set_autoscroll(true);
        }, { passive: true });
    }

    _apply_mode_visibility() {
        const showRosout = (this.mode === 'rosout');
        this.rosoutOnlyEls.forEach((el) => { el.style.display = showRosout ? '' : 'none'; });
        this.modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.logmode === this.mode));
    }

    set_mode(mode) {
        if (mode !== 'rosout' && mode !== 'status') return;
        if (mode === this.mode) return;
        uiPrefSet('vitulus_log_mode', mode);
        const prev = this.active;
        prev.active = false;
        prev.pendingAppend.length = 0;
        this.mode = mode;
        const next = this.active;
        next.active = true;
        next.expanded = this.expanded;
        this._apply_mode_visibility();
        next._set_autoscroll(true);
        if (this.expanded) next.render_full();
        else next.render_compact();
        next.scroll_to_bottom();
    }

    set_expanded(on) {
        this.expanded = !!on;
        this.rosLog.expanded = this.expanded;
        this.statusLog.expanded = this.expanded;
        this.active.set_expanded(this.expanded);
    }

    // Called when the whole log panel becomes visible.
    render_open() {
        this._apply_mode_visibility();
        if (this.expanded) this.active.render_full();
        else this.active.render_compact();
    }
}


class MoveBaseControl {
    constructor(ros, joy_teleop) {
        this.joy_teleop = joy_teleop;
        this.div_status_speed = document.getElementById("div_status_speed");
        this.span_status_speed = document.getElementById("span_status_speed");
        this.btn_menu_speed_low = document.getElementById("btn_menu_speed_low");
        this.btn_menu_speed_moderate = document.getElementById("btn_menu_speed_moderate");
        this.btn_menu_speed_fast = document.getElementById("btn_menu_speed_fast");

        this.btn_menu_speed_low_sm = document.getElementById("btn_menu_speed_low_sm");
        this.btn_menu_speed_moderate_sm = document.getElementById("btn_menu_speed_moderate_sm");
        this.btn_menu_speed_fast_sm = document.getElementById("btn_menu_speed_fast_sm");
        this.cancelGoalTopic = new ROSLIB.Topic({
            ros: ros,
            name: '/move_base_flex/exe_path/cancel',
            messageType: 'actionlib_msgs/GoalID'
        });
        this.speedTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/speed',
            messageType : 'std_msgs/String'
        });
        // Subscribe to the same topic so the buttons reflect the current speed
        // even when it is changed elsewhere (smach program, another browser).
        this.speedStatusTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/speed',
            messageType : 'std_msgs/String'
        });
        this.speed_lin_fast = 0.75;
        this.speed_ang_fast = 1.5;
        this.speed_lin_moderate = 0.4;
        this.speed_ang_moderate = 1.3;
        this.speed_lin_slow = 0.25;
        this.speed_ang_slow = 0.6;
        this.speed_lin_current = this.speed_lin_moderate;
        this.speed_ang_current = this.speed_ang_moderate;
        // Keyboard teleop
        this.keyboard_teleop = new KEYBOARDTELEOP.Teleop({
            ros: ros,
            topic: "/cmd_vel",
            throttle_lin: this.speed_lin_current,
            throttle_ang: this.speed_ang_current
        });
        this.keyboard_teleop.scale = 1.0;
        this.keyboard_teleop.working = false;
        this.checkbox_keyboard = document.getElementById('checkbox_keyboard_teleop');
        this.checkbox_keyboard.checked = false;

        this.init();
    }

    init() {
        this.cancelGoalTopic.advertise();
        this.speedTopic.advertise();
        this.speedStatusTopic.subscribe((msg) => this.update_speed_buttons(msg.data));
    }
    update_speed_buttons(speed) {
        // speed is the canonical /navi_manager/speed value: SLOW | MEDIUM | FAST.
        // Highlight the active button (blue) and reset the others (white).
        // Purely visual — does NOT publish, so there is no feedback loop.
        const white = "#ffffff";
        const blue = "#446de5";
        let low = white, moderate = white, fast = white, label = '';
        if (speed === 'SLOW') { low = blue; label = 'SLOW'; }
        else if (speed === 'MEDIUM') { moderate = blue; label = 'MODERATE'; }
        else if (speed === 'FAST') { fast = blue; label = 'FAST'; }
        else { return; }  // unknown value, leave UI untouched
        this.btn_menu_speed_low.style.color = low;
        this.btn_menu_speed_moderate.style.color = moderate;
        this.btn_menu_speed_fast.style.color = fast;
        this.btn_menu_speed_low_sm.style.color = low;
        this.btn_menu_speed_moderate_sm.style.color = moderate;
        this.btn_menu_speed_fast_sm.style.color = fast;
        this.span_status_speed.innerText = label;
    }
    pub_cancel_goal() {
        const cancelGoalMsg = new ROSLIB.Message({});
        this.cancelGoalTopic.publish(cancelGoalMsg);
        console.log('Cancel goal published and motors stopped.');
    }
    pub_set_speed(speed) {
        if (speed === 'slow') {
            this.speedTopic.publish({data: 'SLOW'});
            this.span_status_speed.innerText = 'SLOW';
            this.speed_lin_current = this.speed_lin_slow;
            this.speed_ang_current = this.speed_ang_slow;
        }
        if (speed === 'moderate') {
            this.speedTopic.publish({data: 'MEDIUM'});
            this.span_status_speed.innerText = 'MODERATE';
            this.speed_lin_current = this.speed_lin_moderate;
            this.speed_ang_current = this.speed_ang_moderate;
        }
        if (speed === 'fast') {
            this.speedTopic.publish({data: 'FAST'});
            this.span_status_speed.innerText = 'FAST';
            this.speed_lin_current = this.speed_lin_fast;
            this.speed_ang_current = this.speed_ang_fast;
        }
        this.keyboard_teleop.throttle_lin = this.speed_lin_current;
        this.keyboard_teleop.throttle_ang = this.speed_ang_current;
    }
    btn_speed_fast_onclick() {
        this.joy_teleop.speed_lin = this.speed_lin_fast;
        this.joy_teleop.speed_ang = this.speed_ang_fast;
        this.pub_set_speed('fast');
        this.btn_menu_speed_low.style.color = "#ffffff";
        this.btn_menu_speed_moderate.style.color = "#ffffff";
        this.btn_menu_speed_fast.style.color = "#446de5";
        this.btn_menu_speed_low_sm.style.color = "#ffffff";
        this.btn_menu_speed_moderate_sm.style.color = "#ffffff";
        this.btn_menu_speed_fast_sm.style.color = "#446de5";
    }
    btn_speed_moderate_onclick() {
        this.joy_teleop.speed_lin = this.speed_lin_moderate;
        this.joy_teleop.speed_ang = this.speed_ang_moderate;
        this.pub_set_speed('moderate');
        this.btn_menu_speed_low.style.color = "#ffffff";
        this.btn_menu_speed_moderate.style.color = "#446de5";
        this.btn_menu_speed_fast.style.color = "#ffffff";
        this.btn_menu_speed_low_sm.style.color = "#ffffff";
        this.btn_menu_speed_moderate_sm.style.color = "#446de5";
        this.btn_menu_speed_fast_sm.style.color = "#ffffff";
    }
    btn_speed_slow_onclick() {
        this.joy_teleop.speed_lin = this.speed_lin_slow;
        this.joy_teleop.speed_ang = this.speed_ang_slow;
        this.pub_set_speed('slow');
        this.btn_menu_speed_low.style.color = "#446de5";
        this.btn_menu_speed_moderate.style.color = "#ffffff";
        this.btn_menu_speed_fast.style.color = "#ffffff";
        this.btn_menu_speed_low_sm.style.color = "#446de5";
        this.btn_menu_speed_moderate_sm.style.color = "#ffffff";
        this.btn_menu_speed_fast_sm.style.color = "#ffffff";
    }
}


class StatusBar {
    constructor(ros) {
        this.active_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/active_map',
            messageType : 'std_msgs/String'
        });
        this.is_indoor_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/is_indoor',
            messageType : 'std_msgs/Bool'
        });
        this.nextion_log_info_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/nextion/log_info',
            messageType : 'std_msgs/String'
        });
        this.span_status_info = document.getElementById("span_status_info");
        this.span_status_info.style.display = "none";

        this.div_status_follow_ico = document.getElementById("div_status_follow_ico");
        this.div_status_follow_ico.style.display = "inline-flex";
        this.div_status_follow_txt = document.getElementById("div_status_follow_txt");
        this.div_status_follow_txt.style.display = "inline-flex";
        this.span_status_follow = document.getElementById("span_status_follow");
        this.span_status_follow.style.display = "inline";
        this.set_follow_text("Map");

        this.div_status_map_name = document.getElementById("div_status_map_name");
        this.div_status_map_name.style.display = "none";
        this.div_status_map_ico = document.getElementById("div_status_map_ico");
        this.div_status_map_ico.style.display = "none";
        this.span_status_map_name = document.getElementById("span_status_map_name");
        this.span_status_map_name.style.display = "none";
        this.ico_map_outdoor = document.getElementById("ico_map_outdoor");
        this.ico_map_outdoor.style.display = "none";
        this.ico_map_indoor = document.getElementById("ico_map_indoor");
        this.ico_map_indoor.style.display = "none";
        this.ico_status_follow = document.getElementById("ico_status_follow");
        this.ico_status_follow.style.display = "inline";
        this.timeout = 10000;
        this.info_timeout = setTimeout(this.hide_status_info, this.timeout);
        this.is_indoor = false;

    }
    set_follow_text(text) {
        this.span_status_follow.innerText = text;
    }
    set_map_name(message) {
        this.div_status_map_name.style.display = "inline-flex";
        this.div_status_map_ico.style.display = "inline-flex";
        this.span_status_map_name.style.display = "inline";
        // vitulus_ui R3 (2026-07-19): was a direct innerText write of the legacy
        // navi map name — bypassed the site/legacy reconciliation added in R2, so
        // this mini status-bar panel kept showing the legacy map name even once a
        // mapping-v3 site was served. Stamp data-legacy and let the shared
        // renderer (window.renderActiveMapName, registered via
        // ACTIVE_MAP_NAME_ELS) decide whether it shows here or falls back to the
        // tooltip, same as the Map-tab header (#active_map_name).
        this.span_status_map_name.setAttribute('data-legacy', message.data.split('***env*')[0]);
        if (window.renderActiveMapName) window.renderActiveMapName();
    }
    set_indoor(message) {
        if (message.data === true) {
                this.ico_map_outdoor.style.display = "none";
                this.ico_map_indoor.style.display = "inline";
                this.is_indoor = true;
            }
            else {
                this.ico_map_outdoor.style.display = "inline";
                this.ico_map_indoor.style.display = "none";
                this.is_indoor = false;
            }
    }
    set_status_info_text(text) {
        this.span_status_info.innerText = text;
        this.span_status_info.style.display = "inline";
    }
    hide_status_info() {
        this.span_status_info.style.display = "none";
        this.span_status_info.innerText = " ";
    }
}


class LayoutManager {
    constructor(viewer, camera_view) {
        this.viewer = viewer;
        this.camera_view = camera_view;
        this.is_portrait = true;
        this.div_menu = document.getElementById("div_menu");
        this.menu_spacer = document.getElementById("menu_spacer");
        this.div_content = document.getElementById("div_content");
        this.map_view = document.getElementById("map_view");
        this.div_camera_view = document.getElementById("div_camera_view");
        this.div_log_view = document.getElementById("div_log_view");
        this.div_bottom_menu = document.getElementById("div_bottom_menu");
        this.tab_power = document.getElementById("tab_power");
        this.tab_mower = document.getElementById("tab_mower");
        this.tab_motors = document.getElementById("tab_motors");
        this.tab_diag = document.getElementById("tab_diag");

    }
    set_layout() {
        // vitulus_ui: in the merged single page the map view is one of several
        // sections. When it is not the active section its container collapses to
        // zero height, which would make set_landscape_layout() hide the SHARED
        // top navbar (it hides it when height < 600). Skip layout while hidden;
        // it runs again when the map section is shown (app.js dispatches resize).
        var sec = document.getElementById('section_map');
        if (sec && sec.style.display === 'none') return;
        if (this.is_portrait) {
            this.set_portrait_layout();
        }
        else {
            this.set_landscape_layout();
        }
    }

    set_portrait_layout() {
        // console.log("Portrait orientation");
        var width = document.getElementById("div_container").offsetWidth;
        var height = document.getElementById("div_container").offsetHeight;
        this.div_menu.style.display = 'block';
        this.menu_spacer.style.display = 'block';
        this.div_content.style.setProperty('height', 'calc(100vh - 42px)');
        this.div_bottom_menu.style.setProperty('margin-top', 'calc(100vh - 29px)');
        this.div_camera_view.style.height = '120px';
        this.div_camera_view.style.width = '160px';
        this.camera_view.changeViewerSize_cam_view();

        if (this.div_log_view.style.display === "block" && !this.div_log_view.classList.contains('log-expanded')){
            this.div_camera_view.style.setProperty('margin-top', 'calc(100vh - 268px)');
        }
        else {
            this.div_camera_view.style.setProperty('margin-top', 'calc(100vh - 157px)');
        }
        if (!this.div_log_view.classList.contains('log-expanded')) {
            this.div_log_view.style.marginLeft = '4px';
            this.div_log_view.style.setProperty('width', 'calc(100vw - 8px)');
        }
        this.tab_power.style.maxHeight = height - 145 + 'px';
        this.tab_mower.style.maxHeight = height - 145 + 'px'
        this.tab_motors.style.maxHeight = height - 145 + 'px'
        this.tab_diag.style.maxHeight = height - 145 + 'px'

        this.viewer.changeViewerSize();
    };
    set_landscape_layout(viewer) {
        // console.log("Landscape orientation");
        var width = document.getElementById("div_container").offsetWidth;
        var height = document.getElementById("div_container").offsetHeight;
        if (height < 600) {
            this.div_menu.style.display = 'none';
            this.menu_spacer.style.display = 'none';
            this.div_content.style.setProperty('height', '100vh');
            this.map_view.style.setProperty('height', '100vh');
        }
        else {
            this.div_menu.style.display = 'block';
            this.menu_spacer.style.display = 'block';
            this.div_content.style.setProperty('height', 'calc(100vh - 42px)');
        }

        this.div_bottom_menu.style.setProperty('margin-top', 'calc(100vh - 29px)');
        this.div_camera_view.style.setProperty('margin-top', 'calc(100vh - 141px)');
        this.div_camera_view.style.height = '106px';
        this.camera_view.changeViewerSize_cam_view();

        let cam_w = parseInt(this.div_camera_view.style.width.replace('px', ''));
        if (!this.div_log_view.classList.contains('log-expanded')) {
            if (this.div_camera_view.style.display === "block"){
                this.div_log_view.style.setProperty('margin-left', (cam_w + 8) + 'px');
                this.div_log_view.style.setProperty('width', 'calc(100vw - ' + (cam_w + 12) +  'px)');
            }
            else {
                this.div_log_view.style.marginLeft = '4px';
                this.div_log_view.style.setProperty('width', 'calc(100vw - 8px)');
            }
        }
        this.tab_power.style.maxHeight = height - 100 + 'px';
        this.tab_mower.style.maxHeight = height - 100 + 'px'
        this.tab_motors.style.maxHeight = height - 100 + 'px'
        this.tab_diag.style.maxHeight = height - 100 + 'px'

        this.viewer.changeViewerSize();
    };
}

// Nav status: two compact panels.
//  POSE  — what currently drives the position estimate (RTK / VO / LiDAR /
//          WHEEL), the heading source (SAT/IMU), per-source availability chips
//          (green=usable, grey=no, white outline=active) and bridge divergence.
//  GNSS  — RTK fix state, satellite count, position and heading accuracy.
class Odom{
    constructor(ros) {
        this.div_odom = document.getElementById("div_odom");
        // POSE panel
        this.span_odom_drive = document.getElementById("span_odom_drive");
        this.span_odom_hdg   = document.getElementById("span_odom_hdg");
        this.span_odom_vo    = document.getElementById("span_odom_vo");
        this.span_odom_licp  = document.getElementById("span_odom_licp");
        this.span_odom_wheel = document.getElementById("span_odom_wheel");
        this.span_odom_div   = document.getElementById("span_odom_div");
        this.span_odom_fix   = document.getElementById("span_odom_fix");
        this.span_odom_prob  = document.getElementById("span_odom_prob");
        // GNSS panel
        this.span_gnss_fix   = document.getElementById("span_gnss_fix");
        this.span_gnss_sats  = document.getElementById("span_gnss_sats");
        this.span_gnss_pos   = document.getElementById("span_gnss_pos");
        this.span_gnss_hdg   = document.getElementById("span_gnss_hdg");

        var self = this;
        // heading source (SAT/IMU) — subscribed externally too (process_msg)
        this.odom_status_topic = new ROSLIB.Topic({
            ros : ros, name : '/nav_tf/odom_status', messageType : 'vitulus_msgs/Navi_transform'
        });
        // what drives the pose + source availability
        this.bridge_status_topic = new ROSLIB.Topic({
            ros : ros, name : '/nav_tf/bridge_status', messageType : 'std_msgs/String'
        });
        this.bridge_status_topic.subscribe(function (m) { self.process_bridge(m.data); });
        // authoritative pose ownership (dock/gps/tracker/rtabmap/legacy/dr);
        // once this arrives it takes over the span_odom_drive badge from the
        // bridge_status heuristic below (see have_loc_status flag)
        this.have_loc_status = false;
        this.loc_status_topic = new ROSLIB.Topic({
            ros : ros, name : '/nav_tf/loc_status', messageType : 'std_msgs/String'
        });
        this.loc_status_topic.subscribe(function (m) { self.process_loc_status(m.data); });
        // GNSS detail
        this.gnss_fix_topic = new ROSLIB.Topic({
            ros : ros, name : '/gnss/fix', messageType : 'sensor_msgs/NavSatFix'
        });
        this.gnss_fix_topic.subscribe(function (m) { self.process_gnss_fix(m); });
        this.navpvt_topic = new ROSLIB.Topic({
            ros : ros, name : '/gnss/navpvt', messageType : 'ublox_msgs/NavPVT'
        });
        this.navpvt_topic.subscribe(function (m) { self.process_navpvt(m); });
        this.navheading_topic = new ROSLIB.Topic({
            ros : ros, name : '/gnss_heading/navheading', messageType : 'sensor_msgs/Imu'
        });
        this.navheading_topic.subscribe(function (m) { self.process_navheading(m); });
    }

    // heading source SAT (RTK dual-antenna) vs IMU fallback.
    // Use the live `heading` usability flag, NOT the `status` string: status is
    // sticky and stayed "SAT" even after the RTK heading was lost (flag=0).
    process_msg(message) {
        if (!this.span_odom_hdg) return;
        var sat = message.heading !== 0;
        this.span_odom_hdg.textContent = sat ? "SAT" : "IMU";
        this.span_odom_hdg.style.background = sat ? "#5cb85c" : "#777777";
    }

    _chip(el, m, active) {
        if (!el) return;
        var on = (m && m[1] === "1");
        el.style.background = on ? "#5cb85c" : "#555555";
        el.style.color = on ? "#0c2a12" : "#dddddd";   // dark text on green, light on grey
        el.style.outline = active ? "1px solid #fff" : "none";
    }

    process_bridge(s) {
        if (!s) return;
        var g = /gps_good=(\d)/.exec(s), act = /active=(\w+)/.exec(s), dv = /shadow_div_m=([\d.]+)/.exec(s);
        var fu = /fix_usable=(\d)/.exec(s);
        var a = act ? act[1] : "";
        // remembered for the DR badge: which odom source carries dead-reckoning
        this.last_bridge_active = a;
        // Ownership badge: loc_status is authoritative once it has arrived
        // (gps_good here no longer means "pose ownership", it can be false
        // at dock/during GPS probation even with a good fix). Keep this
        // heuristic only as a fallback before the first loc_status message.
        if (!this.have_loc_status && this.span_odom_drive) {
            var label = (g && g[1] === "1") ? "RTK"
                      : ({vo: "VO", licp: "LiDAR", wheel: "WHEEL"}[a] || (a ? a.toUpperCase() : "—"));
            var color = label === "RTK" ? "#5cb85c" : (label === "WHEEL" ? "#d9534f" : "#f0ad4e");
            this.span_odom_drive.textContent = label;
            this.span_odom_drive.style.background = color;
        }
        this._chip(this.span_odom_vo,    /vo\[use=(\d)/.exec(s),    a === "vo");
        this._chip(this.span_odom_licp,  /licp\[use=(\d)/.exec(s),  a === "licp");
        this._chip(this.span_odom_wheel, /wheel\[use=(\d)/.exec(s), a === "wheel");
        if (this.span_odom_div && dv) this.span_odom_div.textContent = "Δ" + parseFloat(dv[1]).toFixed(2);
        // fix_usable fallback (only used if loc_status hasn't supplied it yet)
        if (!this.have_loc_status && this.span_odom_fix && fu) {
            var on = fu[1] === "1";
            this.span_odom_fix.style.background = on ? "#5cb85c" : "#555555";
            this.span_odom_fix.style.color = on ? "#0c2a12" : "#dddddd";
        }
    }

    // authoritative pose ownership + fix/probation chips (/nav_tf/loc_status)
    process_loc_status(data) {
        var o;
        try { o = JSON.parse(data); } catch (e) { return; }
        this.have_loc_status = true;

        if (this.span_odom_drive) {
            var labels = {
                gps: ["RTK", "#5cb85c"],
                dock: ["DOCK", "#5cb85c"],       // precise anchor, not degraded
                tracker: ["TRACKER", "#f0ad4e"],
                rtabmap: ["RTABMAP", "#f0ad4e"],
                legacy: ["EXT", "#f0ad4e"],
                dr: ["DEAD-RECKON", "#d9534f"]
            };
            var lc = labels[o.owner] || ["—", "#555555"];
            var txt = lc[0];
            // DR = unanchored, but show WHICH odometry carries it (wheel+IMU
            // always; VO/LiDAR when healthy) so "DR (LICP)" reads as "lidar
            // odometry dead-reckons, no absolute anchor" — not "lidar is dead".
            if (o.owner === "dr" && this.last_bridge_active &&
                    this.last_bridge_active !== "none") {
                txt = "DR (" + this.last_bridge_active.toUpperCase() + ")";
            }
            this.span_odom_drive.textContent = txt;
            this.span_odom_drive.style.background = lc[1];
            this.span_odom_drive.title = "pose owner (loc_status)";
        }
        if (this.span_odom_fix) {
            var fixOn = !!o.fix_usable;
            this.span_odom_fix.style.background = fixOn ? "#5cb85c" : "#555555";
            this.span_odom_fix.style.color = fixOn ? "#0c2a12" : "#dddddd";
        }
        if (this.span_odom_prob) {
            var probOn = !!o.probation_proven;
            this.span_odom_prob.style.background = probOn ? "#5cb85c" : "#555555";
            this.span_odom_prob.style.color = probOn ? "#0c2a12" : "#dddddd";
        }
    }

    process_gnss_fix(m) {
        var st = (m.status && typeof m.status.status === "number") ? m.status.status : 0;
        if (this.span_gnss_fix) {
            var fix = st === 2 ? "FIX" : (st === 1 ? "SBAS" : "NO FIX");
            this.span_gnss_fix.textContent = fix;
            this.span_gnss_fix.style.background = st === 2 ? "#5cb85c" : (st === 1 ? "#f0ad4e" : "#d9534f");
        }
        if (this.span_gnss_pos) {
            // Only trust the position covariance when there is a real fix — the
            // receiver keeps reporting a tiny ~1.5cm covariance even at status=0
            // (no fix), which is why we must gate on the fix status.
            if (st === 0 || !m.position_covariance) {
                this.span_gnss_pos.textContent = "pos —";
                this.span_gnss_pos.style.color = "#d9534f";
            } else {
                var cm = Math.sqrt(m.position_covariance[0]) * 100.0;
                this.span_gnss_pos.textContent = "pos ±" + (cm < 10 ? cm.toFixed(1) : cm.toFixed(0)) + "cm";
                this.span_gnss_pos.style.color = cm <= 5 ? "#5cb85c" : (cm <= 50 ? "#f0ad4e" : "#d9534f");
            }
        }
    }

    process_navpvt(m) {
        if (this.span_gnss_sats) this.span_gnss_sats.textContent = "sats " + (m.numSV != null ? m.numSV : "–");
    }

    process_navheading(m) {
        if (!this.span_gnss_hdg) return;
        var cov = m.orientation_covariance ? m.orientation_covariance[8] : null;
        if (cov == null || cov >= 100) {   // 1000 == no RTK heading
            this.span_gnss_hdg.textContent = "hdg —";
            this.span_gnss_hdg.style.color = "#777777";
            return;
        }
        var deg = Math.sqrt(cov) * 180.0 / Math.PI;
        this.span_gnss_hdg.textContent = "hdg ±" + deg.toFixed(1) + "°";
        // green up to ~2 deg: that is the band navi_transform actually accepts
        // RTK heading at, so normal good heading reads green, not amber.
        this.span_gnss_hdg.style.color = deg <= 2 ? "#5cb85c" : (deg <= 6 ? "#f0ad4e" : "#d9534f");
    }
}

class RtabMap{
    constructor(ros) {
        this.div_rtabmap = document.getElementById("div_rtabmap");
        // visibility (not display) so the panel always reserves its slot and the
        // right-hand panels don't shift down when rtabmap appears/disappears.
        this.div_rtabmap.style.visibility = "hidden";
        this.span_rtabmap_id = document.getElementById("span_rtabmap_id");
        this.span_rtabmap_proximity = document.getElementById("span_rtabmap_proximity");
        this.span_rtabmap_lc = document.getElementById("span_rtabmap_lc");
        this.span_rtabmap_loc_map = document.getElementById("span_rtabmap_loc_map");
        this.btn_menu_map_rtabmap_mapping = document.getElementById("btn_menu_map_rtabmap_mapping");
        this.btn_menu_map_rtabmap_localization = document.getElementById("btn_menu_map_rtabmap_localization");
        this.rtabmap_status_topic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/is_rtabmap',
            messageType : 'std_msgs/Bool'
        });
        this.rtabmap_info_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/rtabmap/info',
            messageType : 'rtabmap_msgs/Info'
        });
        this.rtabmap_localization_srvs = new ROSLIB.Service({
            ros : ros,
            name : '/rtabmap/set_mode_localization',
            serviceType : 'std_srvs/EmptyRequest'
        });
        this.rtabmap_mapping_srvs = new ROSLIB.Service({
            ros : ros,
            name : '/rtabmap/set_mode_mapping',
            serviceType : 'std_srvs/EmptyRequest'
        });
        this.request = new ROSLIB.ServiceRequest({});
        this.is_rtabmap = false;
        this.is_localization = false;
    }

    set_rtabmap_localization(){
        this.rtabmap_localization_srvs.callService(this.request, function(result) {
            // console.log(result);
            console.log('Result for service call on rtabmap localization: ' + result);
        });
    }

    set_rtabmap_mapping(){
        this.rtabmap_mapping_srvs.callService(this.request, function(result) {
            // console.log(result);
            console.log('Result for service call on rtabmap mapping: ' + result);
        });
    }

    set_info(message){
        if (message.proximityDetectionId > 0){
            this.span_rtabmap_proximity.style.background = "#fff500";
        }
        else {
            this.span_rtabmap_proximity.style.background = "#555555";
        }
        if (message.loopClosureId > 0){
            this.span_rtabmap_lc.style.background = "#00d716";
        }
        else {
            this.span_rtabmap_lc.style.background = "#555555";
        }
        this.span_rtabmap_id.innerText = message.refId;

        let status = 'localization';
        this.is_localization = true;
        let localize= true;
        message.statsKeys.forEach(function (item, index) {
            if (item === 'Memory/Rehearsal_sim/') {
                status = 'mapping';
                localize = false;
            }
        });
        this.is_localization = localize;
        // loc/map text row was removed from the panel (it just flipped mapping<->
        // localization noisily); keep the is_localization logic for the buttons.
        if (this.span_rtabmap_loc_map) this.span_rtabmap_loc_map.innerText = status;
    }
    rtabmap_loc_map_buttons_state(){
        // console.log("rtabmap_loc_map_buttons_state");
        if (this.is_rtabmap === true) {
            if (this.is_localization === true) {
                this.btn_menu_map_rtabmap_mapping.style.color = "#ffffff";
                this.btn_menu_map_rtabmap_localization.style.color = "#446de5";
            } else {
                this.btn_menu_map_rtabmap_mapping.style.color = "#446de5";
                this.btn_menu_map_rtabmap_localization.style.color = "#ffffff";
            }
        } else {
            this.btn_menu_map_rtabmap_mapping.style.color = "#ffffff";
            this.btn_menu_map_rtabmap_localization.style.color = "#ffffff";
        }
    }
}


class Diag {
    constructor(ros) {
        this.diag_arr = [];
        this.div_diag_all = document.getElementById("div_diag_all");
        this.diag_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/diagnostics',
            messageType: 'diagnostic_msgs/DiagnosticArray'
        });
    }
    diag_data(message, diag_arr) {
        message.status.forEach(function(element){
            var contains_element = false;
            diag_arr.forEach(function(item){
                if (item.name === element.name){
                    item.message = element.message;
                    item.level = element.level;
                    contains_element = true;
                }
            });
            if (contains_element === false){
                diag_arr.push(element);
            }
        });
        var diag_html_content = '';
        diag_arr.forEach(function(item){
            var diag_html_item = '<div>';
            diag_html_item += '<span>' + item.name + ': </span> ';
            if (item.level === 0){ diag_html_item += '<span style="color: var(--bs-success);">' + item.message + '</span>';};
            if (item.level === 1){ diag_html_item += '<span style="color: var(--bs-warning);">' + item.message + '</span>';}
            if (item.level === 2){ diag_html_item += '<span style="color: var(--bs-danger);">' + item.message + '</span>';}
            diag_html_item += '</div>';
            diag_html_content += diag_html_item;
        });
        this.div_diag_all.innerHTML = diag_html_content;
    }
}


class RosbagControl {
    /**
     * Controls all vitulus_rosbag recorder instances via ROSLIB topics.
     * To add a new recorder, add its topics in the constructor and expose
     * start/stop/set_fps methods following the d435_* pattern below.
     */
    constructor(ros) {

        // --- D435 recorder UI elements ---
        this.btn_d435_rec_start   = document.getElementById("btn_d435_rec_start");
        this.btn_d435_rec_stop    = document.getElementById("btn_d435_rec_stop");
        this.span_d435_rec_status = document.getElementById("span_d435_rec_status");
        this.input_d435_rec_fps   = document.getElementById("input_d435_rec_fps");
        this.btn_d435_rec_fps     = document.getElementById("btn_d435_rec_fps");
        this.span_d435_rec_fps    = document.getElementById("span_d435_rec_fps");
        this.inputgroup_d435_rec  = document.getElementById("inputgroup_d435_rec");

        // --- D435 recorder ROS topics ---
        this.d435_record_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/vitulus_rosbag/d435/record',
            messageType: 'std_msgs/Bool'
        });
        this.d435_fps_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/vitulus_rosbag/d435/set_fps',
            messageType: 'std_msgs/Float32'
        });
        this.d435_status_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/vitulus_rosbag/d435/status',
            messageType: 'std_msgs/String'
        });

        this.d435_record_topic.advertise();
        this.d435_fps_topic.advertise();

        // --- GNSS forensics recorder (heading variance, fix quality, pose
        // ownership — see vitulus_rosbag recorders.yaml 'gnss') ---
        this.btn_gnss_rec_start   = document.getElementById("btn_gnss_rec_start");
        this.btn_gnss_rec_stop    = document.getElementById("btn_gnss_rec_stop");
        this.span_gnss_rec_status = document.getElementById("span_gnss_rec_status");
        this.inputgroup_gnss_rec  = document.getElementById("inputgroup_gnss_rec");

        this.gnss_record_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/vitulus_rosbag/gnss/record',
            messageType: 'std_msgs/Bool'
        });
        this.gnss_status_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/vitulus_rosbag/gnss/status',
            messageType: 'std_msgs/String'
        });
        this.gnss_record_topic.advertise();
    }

    // --- D435 methods ---

    d435_start() {
        this.d435_record_topic.publish(new ROSLIB.Message({ data: true }));
    }

    d435_stop() {
        this.d435_record_topic.publish(new ROSLIB.Message({ data: false }));
    }

    d435_set_fps(fps) {
        this.d435_fps_topic.publish(new ROSLIB.Message({ data: fps }));
        this.span_d435_rec_fps.textContent = fps.toFixed(1) + ' fps';
    }

    d435_status_data(message) {
        this.span_d435_rec_status.textContent = message.data;
        if (message.data.startsWith('recording')) {
            this.inputgroup_d435_rec.style.setProperty('border', '2px solid var(--bs-success)');
            this.span_d435_rec_status.className = 'text-success d-flex justify-content-end input-group-text form-control';
            const fps_match = message.data.match(/fps=(\d+\.?\d*)/);
            if (fps_match) {
                this.span_d435_rec_fps.textContent = fps_match[1] + ' fps';
            }
        } else {
            this.inputgroup_d435_rec.style.setProperty('border', '2px solid var(--bs-danger)');
            this.span_d435_rec_status.className = 'text-info d-flex justify-content-end input-group-text form-control';
        }
    }

    // --- GNSS methods ---

    gnss_start() {
        this.gnss_record_topic.publish(new ROSLIB.Message({ data: true }));
    }

    gnss_stop() {
        this.gnss_record_topic.publish(new ROSLIB.Message({ data: false }));
    }

    gnss_status_data(message) {
        this.span_gnss_rec_status.textContent = message.data;
        if (message.data.startsWith('recording')) {
            this.inputgroup_gnss_rec.style.setProperty('border', '2px solid var(--bs-success)');
            this.span_gnss_rec_status.className = 'text-success d-flex justify-content-end input-group-text form-control';
        } else {
            this.inputgroup_gnss_rec.style.setProperty('border', '2px solid var(--bs-danger)');
            this.span_gnss_rec_status.className = 'text-info d-flex justify-content-end input-group-text form-control';
        }
    }
}


class BagManager {
    /**
     * Lists stored rosbag files via the webui backend and offers
     * download / delete actions. Refreshes on demand only (cheap).
     */
    constructor() {
        this.div_list    = document.getElementById('div_bag_list');
        this.btn_refresh = document.getElementById('btn_bag_refresh');
        this.span_total  = document.getElementById('span_bag_total');
        this.span_name   = document.getElementById('span_modal_remove_bag_name');
        this.btn_confirm = document.getElementById('btn_modal_remove_bag');
        this.pending_path = null;
        this.in_flight = false;
    }

    init() {
        if (!this.div_list) return;
        this.btn_refresh.addEventListener('click', () => this.refresh());
        this.btn_confirm.addEventListener('click', () => this.confirm_delete());
        // Refresh automatically when user opens the Rosbag tab
        const tab_link = document.querySelector('a[href="#tab_rosbag"]');
        if (tab_link) {
            tab_link.addEventListener('shown.bs.tab', () => this.refresh());
        }
        // Initial fetch (lazy — UI already usable)
        this.refresh();
    }

    human_size(n) {
        if (n < 1024) return n + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let v = n / 1024, i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(v >= 10 ? 0 : 1) + ' ' + units[i];
    }

    human_time(ts) {
        const d = new Date(ts * 1000);
        const pad = (x) => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
             + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    refresh() {
        if (this.in_flight) return;
        this.in_flight = true;
        fetch('/rosbag/list', { cache: 'no-store' })
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .then(data => this.render(data))
            .catch(err => {
                this.div_list.innerHTML = '<div class="bag-empty" style="padding:12px;font-size:12px;color:var(--bs-danger);text-align:center;">Failed to load bag list (' + err + ')</div>';
                this.span_total.textContent = '';
            })
            .finally(() => { this.in_flight = false; });
    }

    render(data) {
        const items = data.items || [];
        if (!items.length) {
            this.div_list.innerHTML = '<div class="bag-empty" style="padding:12px;font-size:12px;color:#9aa0a6;text-align:center;">No bags recorded yet.</div>';
            this.span_total.textContent = '0 files';
            return;
        }
        this.span_total.textContent = items.length + ' file' + (items.length === 1 ? '' : 's') + ' · ' + this.human_size(data.total_size || 0);

        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const rows = items.map(it => {
            const loc = it.subdir ? it.subdir + ' · ' : '';
            const dl_url = '/rosbag/download?path=' + encodeURIComponent(it.path);
            const del_attrs = it.active
                ? 'disabled title="Recording in progress"'
                : 'data-path="' + esc(it.path) + '" data-name="' + esc(it.name) + '"';
            const dl_attrs = it.active
                ? 'disabled title="Recording in progress" href="#" onclick="return false;"'
                : 'href="' + dl_url + '" download';
            return '<div class="bag-row' + (it.active ? ' active' : '') + '">' +
                '<div class="bag-info">' +
                    '<div class="bag-name">' + esc(it.name) + '</div>' +
                    '<div class="bag-meta">' + esc(loc) + this.human_size(it.size) + ' · ' + this.human_time(it.mtime) + '</div>' +
                '</div>' +
                '<div class="bag-actions">' +
                    '<a class="btn btn-sm btn-outline-info" ' + dl_attrs + ' title="Download">⬇</a>' +
                    '<button class="btn btn-sm btn-outline-danger" type="button" ' + del_attrs + ' title="Delete">✕</button>' +
                '</div>' +
            '</div>';
        }).join('');
        this.div_list.innerHTML = rows;

        this.div_list.querySelectorAll('button[data-path]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const p = btn.getAttribute('data-path');
                const n = btn.getAttribute('data-name');
                this.ask_delete(p, n);
            });
        });
    }

    ask_delete(path, name) {
        this.pending_path = path;
        this.span_name.textContent = name;
        const modal_el = document.getElementById('modal_remove_bag');
        const modal = bootstrap.Modal.getOrCreateInstance(modal_el);
        modal.show();
    }

    confirm_delete() {
        if (!this.pending_path) return;
        const path = this.pending_path;
        this.pending_path = null;
        const modal_el = document.getElementById('modal_remove_bag');
        const modal = bootstrap.Modal.getOrCreateInstance(modal_el);
        fetch('/rosbag/delete?path=' + encodeURIComponent(path), { method: 'POST' })
            .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, j })))
            .then(res => {
                modal.hide();
                if (!res.ok) alert('Delete failed: ' + (res.j && res.j.error ? res.j.error : 'unknown'));
                this.refresh();
            })
            .catch(err => {
                modal.hide();
                alert('Delete failed: ' + err);
            });
    }
}


class Mower {
    constructor(ros) {
        this.span_mower_status = document.getElementById("span_mower_status");
        this.span_mower_temp = document.getElementById("span_mower_temp");
        this.span_mower_direction = document.getElementById("span_mower_direction");
        this.span_mower_cut_height = document.getElementById("span_mower_cut_height");
        this.span_mower_rpm = document.getElementById("span_mower_rpm");
        this.div_mower_info_panel = document.getElementById("div_mower_info_panel");
        this.span_mower_panel_status = document.getElementById("span_mower_panel_status");
        this.span_mower_panel_rpm = document.getElementById("span_mower_panel_rpm");
        this.span_mower_panel_height = document.getElementById("span_mower_panel_height");
        this.span_mower_panel_temp = document.getElementById("span_mower_panel_temp");
        this.btn_mower_on = document.getElementById("btn_mower_on");
        this.btn_mower_off = document.getElementById("btn_mower_off");
        this.btn_mower_left = document.getElementById("btn_mower_left");
        this.btn_mower_right = document.getElementById("btn_mower_right");
        this.btn_mower_set_height = document.getElementById("btn_mower_set_height");
        this.btn_mower_set_rpm = document.getElementById("btn_mower_set_rpm");
        this.btn_mower_calibration = document.getElementById("btn_mower_calibration");
        this.btn_mower_home = document.getElementById("btn_mower_home");
        this.btn_mower_start_motor = document.getElementById("btn_mower_start_motor");
        this.btn_mower_stop_motor = document.getElementById("btn_mower_stop_motor");
        this.btn_mower_cmd1_send = document.getElementById("btn_mower_cmd1_send");
        this.btn_mower_cmd2_send = document.getElementById("btn_mower_cmd2_send");
        this.btn_mower_cmd3_send = document.getElementById("btn_mower_cmd3_send");
        this.btn_mower_cmd4_send = document.getElementById("btn_mower_cmd4_send");
        this.input_mower_cmd1 = document.getElementById("input_mower_cmd1");
        this.input_mower_cmd2 = document.getElementById("input_mower_cmd2");
        this.input_mower_cmd3 = document.getElementById("input_mower_cmd3");
        this.input_mower_cmd4 = document.getElementById("input_mower_cmd4");
        this.paragraph_mower_config = document.getElementById("paragraph_mower_config");
        this.input_mower_cut_height = document.getElementById("input_mower_cut_height");
        this.input_mower_rpm = document.getElementById("input_mower_rpm");
        this.inputgroup_mower_on_off = document.getElementById("inputgroup_mower_on_off");

        this.mower_status_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/mower/status',
            messageType: 'vitulus_msgs/Mower'
        });
        this.mower_config_print_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/mower/config_print',
            messageType: 'std_msgs/String'
        });
        this.mower_set_power_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_power',
            messageType : 'std_msgs/Bool'
        });
        this.mower_set_dir_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_motor_dir',
            messageType : 'std_msgs/String'
        });
        this.mower_set_cut_height_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_cut_height',
            messageType : 'std_msgs/Int16'
        });
        this.mower_set_motor_rpm_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_motor_rpm',
            messageType : 'std_msgs/Int16'
        });
        this.mower_set_calibrate_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_calibrate',
            messageType : 'std_msgs/Bool'
        });
        this.mower_set_home_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_home',
            messageType : 'std_msgs/Bool'
        });
        this.mower_set_motor_on_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_motor_on',
            messageType : 'std_msgs/Bool'
        });
        this.mower_set_cmd_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/mower/set_cmd',
            messageType : 'std_msgs/String'
        });
        this.init();
    }

    init() {
        this.mower_set_power_topic.advertise();
        this.mower_set_dir_topic.advertise();
        this.mower_set_cut_height_topic.advertise();
        this.mower_set_motor_rpm_topic.advertise();
        this.mower_set_calibrate_topic.advertise();
        this.mower_set_home_topic.advertise();
        this.mower_set_motor_on_topic.advertise();
        this.mower_set_cmd_topic.advertise();
    }

    mower_status(message) {
        switch (message.status) {
            case 'UNK':
                this.span_mower_status.textContent = 'OFF';
                break;
            case 'CALIBRATING':
                this.span_mower_status.textContent = 'CALIB';
                break;
            case 'CHANGE_HEIGHT':
                this.span_mower_status.textContent = 'HEIGHT';
                break;
            default:
                this.span_mower_status.textContent = message.status;
        }
        if (message.status === 'UNK' || message.status === 'OFF' || message.status === 'ERR' || message.status === 'BLOCKED' || message.status === 'TEMP') {
            this.inputgroup_mower_on_off.style.setProperty('border', '2px solid var(--bs-danger)');
        }
        else {
            if (message.status === 'READY' || message.status === 'RUN') {
                this.inputgroup_mower_on_off.style.setProperty('border', '2px solid var(--bs-success)');
            }
            else {
                this.inputgroup_mower_on_off.style.setProperty('border', '2px solid var(--bs-warning)');
            }
        }

        this.span_mower_direction.textContent = message.moto_dir;
        this.span_mower_cut_height.textContent = message.current_height + "/" + message.max_height + " cm";
        this.span_mower_rpm.textContent = message.moto_rpm + "/" + message.setpoint_rpm + " rpm";
        this.span_mower_temp.textContent = parseInt(message.temp) + "`C";

        // Update mower info panel visibility and values
        if (this.div_mower_info_panel) {
            if (message.status === 'UNK' || message.status === 'OFF') {
                this.div_mower_info_panel.style.display = 'none';
            } else {
                this.div_mower_info_panel.style.display = 'inline-flex';
                this.span_mower_panel_rpm.textContent = message.moto_rpm + " rpm";
                this.span_mower_panel_height.textContent = message.current_height + " cm";
                this.span_mower_panel_temp.textContent = parseInt(message.temp) + "°C";

                // Status text and color
                let statusText = message.status;
                let statusColor = 'var(--bs-warning)';
                if (message.status === 'CALIBRATING') statusText = 'CALIB';
                if (message.status === 'CHANGE_HEIGHT') statusText = 'HEIGHT';
                if (message.status === 'READY' || message.status === 'RUN') {
                    statusColor = 'var(--bs-success)';
                } else if (message.status === 'ERR' || message.status === 'BLOCKED' || message.status === 'TEMP') {
                    statusColor = 'var(--bs-danger)';
                }
                this.span_mower_panel_status.textContent = statusText;
                this.span_mower_panel_status.style.color = statusColor;
            }
        }
    }

    pub_mower_set_power(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_power_topic.publish(msg);
    }

    pub_mower_set_dir(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_dir_topic.publish(msg);
    }

    pub_mower_set_cut_height(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_cut_height_topic.publish(msg);
    }

    pub_mower_set_motor_rpm(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_motor_rpm_topic.publish(msg);
    }

    pub_mower_set_calibrate(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_calibrate_topic.publish(msg);
    }

    pub_mower_set_home(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_home_topic.publish(msg);
    }

    pub_mower_set_motor_on(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_motor_on_topic.publish(msg);
    }

    pub_mower_set_cmd(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.mower_set_cmd_topic.publish(msg);
    }
}


class PowerModule {
    constructor(ros) {
        this.span_supply_volts = document.getElementById("span_supply_volts");
        this.span_supply_amps = document.getElementById("span_supply_amps");
        this.span_batt_volts = document.getElementById("span_batt_volts");
        this.span_batt_amps = document.getElementById("span_batt_amps");
        this.span_nuc_volts = document.getElementById("span_nuc_volts");
        this.span_nuc_amps = document.getElementById("span_nuc_amps");
        this.span_batt_capacity = document.getElementById("span_batt_capacity");
        this.span_supply_status = document.getElementById("span_supply_status");
        this.span_batt_status = document.getElementById("span_batt_status");
        this.span_curr_pcb_temp = document.getElementById("span_curr_pcb_temp");
        this.span_pcb_rpm = document.getElementById("span_pcb_rpm");
        this.span_curr_ext_temp = document.getElementById("span_curr_ext_temp");
        this.span_ext_rpm = document.getElementById("span_ext_rpm");
        this.ico_nuc_conf = document.getElementById("ico_nuc_conf");
        this.ico_motor_conf = document.getElementById("ico_motor_conf");
        this.ico_mower_conf = document.getElementById("ico_mower_conf");
        this.progress_batt_capacity = document.getElementById("progress_batt_capacity");
        this.span_run_charge = document.getElementById("span_run_charge");
        this.span_run_cutoff = document.getElementById("span_run_cutoff");
        this.span_standby_charge = document.getElementById("span_standby_charge");
        this.span_standby_cutoff = document.getElementById("span_standby_cutoff");
        this.span_pcb_temp = document.getElementById("span_pcb_temp");
        this.span_ext_temp = document.getElementById("span_ext_temp");
        this.btn_run_charge = document.getElementById("btn_run_charge");
        this.btn_run_cutoff = document.getElementById("btn_run_cutoff");
        this.btn_standby_charge = document.getElementById("btn_standby_charge");
        this.btn_standby_cutoff = document.getElementById("btn_standby_cutoff");
        this.btn_pcb_temp = document.getElementById("btn_pcb_temp");
        this.btn_ext_temp = document.getElementById("btn_ext_temp");
        this.btn_mower_on_pm = document.getElementById("btn_mower_on_pm");
        this.btn_mower_off_pm = document.getElementById("btn_mower_off_pm");
        this.btn_motor_on_pm = document.getElementById("btn_motor_on_pm");
        this.btn_motor_off_pm = document.getElementById("btn_motor_off_pm");
        this.input_run_charge = document.getElementById("input_run_charge");
        this.input_run_cutoff = document.getElementById("input_run_cutoff");
        this.input_standby_charge = document.getElementById("input_standby_charge");
        this.input_standby_cutoff = document.getElementById("input_standby_cutoff");
        this.input_pcb_temp = document.getElementById("input_pcb_temp");
        this.input_ext_temp = document.getElementById("input_ext_temp");
        this.btn_sleep_time_save = document.getElementById("btn_sleep_time_save");
        this.btn_sleep_timed = document.getElementById("btn_sleep_timed");
        this.btn_sleep_until_charged = document.getElementById("btn_sleep_until_charged");
        this.btn_standby_delay = document.getElementById("btn_standby_delay");
        this.input_sleep_time_min = document.getElementById("input_sleep_time_min");
        this.input_standby_delay = document.getElementById("input_standby_delay");
        this.btn_sleep_charged_offset = document.getElementById("btn_sleep_charged_offset");
        this.input_sleep_charged_offset = document.getElementById("input_sleep_charged_offset");
        this.btn_standby_timeout_discharging = document.getElementById("btn_standby_timeout_discharging");
        this.input_standby_timeout_discharging = document.getElementById("input_standby_timeout_discharging");
        this.span_sleep_time_min = document.getElementById("span_sleep_time_min");
        this.span_standby_delay = document.getElementById("span_standby_delay");
        this.span_sleep_charged_offset = document.getElementById("span_sleep_charged_offset");
        this.span_standby_timeout_discharging = document.getElementById("span_standby_timeout_discharging");

        this.power_status_topic = new ROSLIB.Topic({
            ros: ros.ros,
            name: '/pm/power_status',
            messageType: 'vitulus_ups/power_status'
        });
        this.set_charge_current_running_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_charge_current_running',
            messageType : 'std_msgs/Int16'
        });
        this.set_precharge_current_running_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_precharge_current_running',
            messageType : 'std_msgs/Int16'
        });
        this.set_charge_current_standby_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_charge_current_standby',
            messageType : 'std_msgs/Int16'
        });
        this.set_precharge_current_standby_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_precharge_current_standby',
            messageType : 'std_msgs/Int16'
        });
        this.set_temp_setpoint_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_temp_setpoint',
            messageType : 'std_msgs/Float64'
        });
        this.set_temp2_setpoint_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_temp2_setpoint',
            messageType : 'std_msgs/Float64'
        });
        this.set_bat_out_switch_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_bat_out_switch',
            messageType : 'std_msgs/Bool'
        });
        this.set_motor_switch_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_motor_switch',
            messageType : 'std_msgs/Bool'
        });
        this.set_sleep_time_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_sleep_time',
            messageType : 'std_msgs/UInt64'
        });
        this.set_robot_sleep_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_robot_sleep',
            messageType : 'std_msgs/Bool'
        });
        this.set_sleep_until_charged_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_sleep_until_charged',
            messageType : 'std_msgs/Bool'
        });
        this.set_sleep_wait_before_standby_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_sleep_wait_before_standby',
            messageType : 'std_msgs/UInt64'
        });
        this.set_sleep_wait_charged_offset_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_sleep_wait_charged_offset',
            messageType : 'std_msgs/UInt64'
        });
        this.set_standby_timeout_discharging_topic = new ROSLIB.Topic({
            ros : ros.ros,
            name : '/pm/set_standby_timeout_discharging',
            messageType : 'std_msgs/UInt64'
        });

        this.init();
    }

    init(){
        this.set_charge_current_running_topic.advertise();
        this.set_precharge_current_running_topic.advertise();
        this.set_charge_current_standby_topic.advertise();
        this.set_precharge_current_standby_topic.advertise();
        this.set_temp_setpoint_topic.advertise();
        this.set_temp2_setpoint_topic.advertise();
        this.set_bat_out_switch_topic.advertise();
        this.set_motor_switch_topic.advertise();
        this.set_sleep_time_topic.advertise();
        this.set_robot_sleep_topic.advertise();
        this.set_sleep_until_charged_topic.advertise();
        this.set_sleep_wait_before_standby_topic.advertise();
        this.set_sleep_wait_charged_offset_topic.advertise();
        this.set_standby_timeout_discharging_topic.advertise();
    }

    status_data(message){
        this.span_supply_volts.innerHTML = message.input_voltage.toFixed(2);;
        this.span_supply_amps.innerHTML = message.input_current.toFixed(2);
        this.span_batt_volts.innerHTML = message.battery_voltage.toFixed(2);
        this.span_batt_amps.innerHTML = message.battery_current.toFixed(2);
        this.span_nuc_volts.innerHTML = message.out19_voltage.toFixed(2);
        this.span_nuc_amps.innerHTML = message.out19_current.toFixed(2);
        this.span_batt_capacity.innerHTML = message.battery_capacity.toFixed(0);
        this.span_curr_pcb_temp.innerHTML = message.temp2.toFixed(2);
        this.span_pcb_rpm.innerHTML = message.fan2_rpm;
        this.span_curr_ext_temp.innerHTML = message.temp.toFixed(2);
        this.span_ext_rpm.innerHTML = message.fan_rpm;
        this.span_supply_status.innerHTML = message.supply_status;
        switch (message.supply_status) {
            case 'OFFLINE':
                this.span_supply_status.style.setProperty('color', 'var(--bs-warning)');
                break;
            case 'ONLINE':
                this.span_supply_status.style.setProperty('color', 'var(--bs-success)');
                break;
            case 'FAIL':
                this.span_supply_status.style.setProperty('color', 'var(--bs-danger)');
                break;
        }
        this.span_batt_status.innerHTML = message.charger_status;
        switch (message.charger_status) {
            case 'CHARGED':
                this.span_batt_status.style.setProperty('color', 'var(--bs-success)');
                break;
            case 'CHARGING':
                this.span_batt_status.style.setProperty('color', 'var(--bs-warning)');
                break;
            case 'DISCHARGING':
                this.span_batt_status.style.setProperty('color', 'var(--bs-warning)');
                break;
        }
        if (message.out19v_switch === true) {
            this.ico_nuc_conf.src = "/assets/img/robot_icons/ico_nuc_green.png";
        }else{
            this.ico_nuc_conf.src = "/assets/img/robot_icons/ico_nuc_grey.png";
        }
        if (message.motor_out_switch === true) {
            this.ico_motor_conf.src = "/assets/img/robot_icons/ico_motor_green.png";
        }else{
            this.ico_motor_conf.src = "/assets/img/robot_icons/ico_motor_grey.png";
        }
        if (message.bat_out_switch === true) {
            this.ico_mower_conf.src = "/assets/img/robot_icons/Nextion_ico_mower_green.png";
        }else{
            this.ico_mower_conf.src = "/assets/img/robot_icons/Nextion_ico_mower_grey.png";
        }
        span_batt_capacity.textContent = message.battery_capacity;

        this.progress_batt_capacity.style.width = message.battery_capacity + '%';
        this.progress_batt_capacity.ariaValueNow = message.battery_capacity;
        this.progress_batt_capacity.ariaValueMin = 0;
        this.progress_batt_capacity.ariaValueMax = 100;
        var color_state = 'success';
        if (message.battery_capacity < 50){
            color_state = 'warning'
        }
        if (message.battery_capacity < 20){
            color_state = 'danger'
        }
        this.progress_batt_capacity.className = 'progress-bar bg-' + color_state +'';
        this.span_run_charge.innerHTML = message.charge_current_setpoint_run;
        this.span_run_cutoff.innerHTML = message.precharge_current_setpoint_run;
        this.span_standby_charge.innerHTML = message.charge_current_setpoint_standby;
        this.span_standby_cutoff.innerHTML = message.precharge_current_setpoint_standby;
        this.span_pcb_temp.innerHTML = message.temp2_setpoint;
        this.span_ext_temp.innerHTML = message.temp_setpoint;
        this.span_sleep_time_min.innerHTML = Math.round(message.sleep_time_interval / 60000);
        this.span_standby_delay.innerHTML = Math.round(message.sleep_wait_standby / 60000);
        this.span_sleep_charged_offset.innerHTML = Math.round(message.sleep_wait_charged / 60000);
        this.span_standby_timeout_discharging.innerHTML = Math.round(message.standby_timeout / 60000);
    }

    pub_set_charge_current_running(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_charge_current_running_topic.publish(msg);
    }

    pub_set_precharge_current_running(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_precharge_current_running_topic.publish(msg);
    }

    pub_set_charge_current_standby(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_charge_current_standby_topic.publish(msg);
    }

    pub_set_precharge_current_standby(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_precharge_current_standby_topic.publish(msg);
    }

    pub_set_temp_setpoint(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_temp_setpoint_topic.publish(msg);
    }

    pub_set_temp2_setpoint(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_temp2_setpoint_topic.publish(msg);
    }

    pub_set_bat_out_switch(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_bat_out_switch_topic.publish(msg);
    }

    pub_set_motor_switch(value) {
        let msg = new ROSLIB.Message({
            data: value
        });
        this.set_motor_switch_topic.publish(msg);
    }

    pub_set_sleep_time(minutes) {
        this.set_sleep_time_topic.publish(new ROSLIB.Message({ data: minutes * 60000 }));
    }

    pub_start_sleep() {
        this.set_robot_sleep_topic.publish(new ROSLIB.Message({ data: true }));
    }

    pub_sleep_until_charged() {
        this.set_sleep_until_charged_topic.publish(new ROSLIB.Message({ data: true }));
    }

    pub_wake() {
        this.set_robot_sleep_topic.publish(new ROSLIB.Message({ data: false }));
    }

    pub_set_standby_delay(minutes) {
        this.set_sleep_wait_before_standby_topic.publish(new ROSLIB.Message({ data: minutes * 60000 }));
    }

    pub_set_charged_offset(minutes) {
        this.set_sleep_wait_charged_offset_topic.publish(new ROSLIB.Message({ data: minutes * 60000 }));
    }

    pub_set_standby_timeout_discharging(minutes) {
        this.set_standby_timeout_discharging_topic.publish(new ROSLIB.Message({ data: minutes * 60000 }));
    }
}


class Programs {
    constructor(ros, map_menu, paths_visualization) {
        this.map_menu = map_menu;
        this.paths_visualization = paths_visualization;
        this.program_list_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/web_plan/program_list',
            messageType : 'vitulus_msgs/PlannerProgramList'
        });
        this.reload_planner_data_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/web_plan/reload',
            messageType : 'std_msgs/Bool'
        });
        // Lightweight re-publish (no planner-pickle reload) — used to re-fetch the
        // zone list for the add-zone dropdown without hammering node_planner.
        this.republish_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/web_plan/republish',
            messageType : 'std_msgs/Bool'
        });
        this.smach_stop_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/mower_smach/stop',
            messageType : 'std_msgs/Bool'
        });
        this.smach_reset_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/mower_smach/reset',
            messageType : 'std_msgs/Bool'
        });
        this.smach_status_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/mower_smach/status',
            messageType : 'std_msgs/String'
        });
        this.program_to_show_marker_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/web_plan/program_to_show_marker',
            messageType : 'vitulus_msgs/PlannerProgram'
        });
        this.program_list_Topic.subscribe((message) => {
            this.process_program_list(message);
        });
        this.smach_status_Topic.subscribe((message) => {
            this.map_menu.span_menu_program_status.innerText = message.data;
        });
        this.program_list_msg = new ROSLIB.Message({
            program_list: []
        });
        // Publish selected program to run
        this.topic_program_select = new ROSLIB.Topic({
            ros: ros,
            name: '/web_plan/program_select',
            messageType: 'std_msgs/String'
        });
        this.topic_program_resume = new ROSLIB.Topic({
            ros: ros,
            name: '/web_plan/program_select_resume',
            messageType: 'std_msgs/String'
        });
        this.topic_program_new = new ROSLIB.Topic({
            ros: ros,
            name: '/web_plan/program_new',
            messageType: 'vitulus_msgs/PlannerProgram'
        });
        this.program_list = [];
        this.selected_program = null;
        // vitulus_ui: program editing (create / rename / add+remove zones). The
        // zone palette comes from the planner's zone list; the active map name is
        // needed to stamp a new program's map.
        this.available_zones = [];
        this.active_map_data = '';
        this._editing_new = false;
        this.zone_list_Topic = new ROSLIB.Topic({
            ros: ros, name: '/web_plan/zone_list', messageType: 'vitulus_msgs/MapEditZoneList'
        });
        this.zone_list_Topic.subscribe((m) => { this.available_zones = m.zone_list || []; this._fillZoneDropdown(); });
        this.active_map_data_Topic = new ROSLIB.Topic({
            ros: ros, name: '/navi_manager/active_map', messageType: 'std_msgs/String'
        });
        this.active_map_data_Topic.subscribe((m) => { this.active_map_data = m.data; });
        this.init();
    }

    // ---- program editing (vitulus_ui) -------------------------------------
    // The zone palette comes from /web_plan/zone_list. The zone_list subscription
    // (below) fills the dropdown whenever it arrives, so normally we just render
    // what we have. Only if we have NOTHING yet do we ask for ONE reload (each
    // reload makes node_planner re-load the large planner pickle, so we never
    // spam it — at most one request per session).
    _ensureZones() {
        this._fillZoneDropdown();
        if (this.available_zones.length === 0 && !this._zoneRequested) {
            this._zoneRequested = true;
            // Light re-publish (no pickle reload). A couple of cheap tries cover a
            // dropped one-shot over rosbridge.
            var self = this, n = 0;
            (function tick() {
                if (self.available_zones.length > 0 || n >= 4) { self._fillZoneDropdown(); return; }
                try { self.republish_Topic.publish(new ROSLIB.Message({ data: true })); } catch (e) {}
                n++; window.setTimeout(tick, 2500);
            })();
        }
    }
    _fillZoneDropdown() {
        var sel = document.getElementById('sel_program_add_zone');
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = '';
        this.available_zones.forEach((z) => {
            var o = document.createElement('option');
            o.value = z.name; o.textContent = z.name;
            sel.appendChild(o);
        });
        if (cur) sel.value = cur;
    }
    _renderProgramZones() {
        var c = this.map_menu.row_menu_program_detail_zones;
        if (!c) return;
        var zones = (this.selected_program && this.selected_program.zone_list) || [];
        if (!zones.length) {
            c.innerHTML = '<div class="col-auto"><span class="text-secondary" style="font-size:12px;">No zones — add one below.</span></div>';
            return;
        }
        var html = '';
        zones.forEach((zone) => { html += new ProgramZoneItemTemplate(zone).element; });
        c.innerHTML = html;
    }
    newProgram() {
        this.selected_program = {
            name: '', map_name: this.active_map_data, zone_list: [],
            rpm: 0, cut_height: 0, speed: 'mid', override_zone: false,
            area: 0, length: 0, last_duration_minutes: 0, last_result: '',
        };
        this._editing_new = true;
        this.map_menu.div_menu_program_detail_row.style.display = 'flex';
        this.map_menu.span_menu_program_name.innerText = '(new program)';
        if (this.map_menu.inp_program_name) { this.map_menu.inp_program_name.value = ''; this.map_menu.inp_program_name.focus(); }
        this.map_menu.span_menu_program_area.innerText = '0';
        this.map_menu.span_menu_program_length.innerText = '0';
        this.map_menu.inp_program_rpm.value = 0;
        this.map_menu.inp_program_cut_height.value = 0;
        this._setSpeedButtons('mid');
        this.map_menu.chk_program_override_zone.checked = false;
        this._renderProgramZones();
        this._ensureZones();
    }
    addZoneToProgram() {
        if (!this.selected_program) return;
        var sel = document.getElementById('sel_program_add_zone');
        if (!sel || !sel.value) return;
        var z = this.available_zones.find((x) => x.name === sel.value);
        if (!z) return;
        if (!this.selected_program.zone_list.some((x) => x.name === z.name)) {
            this.selected_program.zone_list.push(z);
            this._renderProgramZones();
        }
    }
    removeZoneFromProgram(name) {
        if (!this.selected_program) return;
        this.selected_program.zone_list = this.selected_program.zone_list.filter((z) => z.name !== name);
        this._renderProgramZones();
    }
    // Save the program (create or update): name + zones + cutting settings, in
    // the same /web_plan/program_new message the planner uses.
    saveProgramEdit() {
        var prg = this.selected_program;
        if (!prg) return;
        var nameInput = this.map_menu.inp_program_name ? this.map_menu.inp_program_name.value.trim() : '';
        var baseName = nameInput || (prg.name ? prg.name.replace(/ \([^)]+\)$/, '') : '');
        if (!baseName) { window.alert('Program name is empty.'); return; }
        if (!prg.zone_list.length) { window.alert('Program has no zones.'); return; }
        var mapData = prg.map_name || this.active_map_data;
        var mapShort = (mapData || '').split('***env*')[0];
        var speed = this.map_menu.btn_program_speed_slow.classList.contains('btn-secondary') ? 'slow'
            : this.map_menu.btn_program_speed_fast.classList.contains('btn-secondary') ? 'fast' : 'mid';
        var area = 0, length = 0;
        prg.zone_list.forEach((z) => { area += z.area || 0; length += z.length || 0; });
        var msg = {
            name: baseName + ' (' + mapShort + ')',
            map_name: mapData,
            area: area, length: length,
            zone_list: prg.zone_list,
            rpm: parseInt(this.map_menu.inp_program_rpm.value) || 0,
            cut_height: parseInt(this.map_menu.inp_program_cut_height.value) || 0,
            speed: speed,
            override_zone: this.map_menu.chk_program_override_zone.checked,
            last_duration_minutes: prg.last_duration_minutes || 0,
            last_result: prg.last_result || '',
        };
        this.topic_program_new.publish(new ROSLIB.Message(msg));
        this._editing_new = false;
    }

    init(){
        this.reload_planner_data_Topic.advertise();
        this.republish_Topic.advertise();
        this.program_to_show_marker_Topic.advertise();
        this.topic_program_select.advertise();
        this.topic_program_resume.advertise();
        this.topic_program_new.advertise();
        this.smach_stop_Topic.advertise();
        this.smach_reset_Topic.advertise();
        this.reload_planner_data();
    }
    reload_planner_data(){
        let msg = new ROSLIB.Message({
            data: true
        });
        this.reload_planner_data_Topic.publish(msg);
    }
    process_program_list(message){
        this.program_list_msg = message;
        // console.log(message);
        this.draw_program_list();
        // settings-persistence: on the FIRST list after load, re-select the
        // remembered program (exact name match; silently skipped if it no
        // longer exists). _zoneRequested is parked around the call so the
        // restore never auto-publishes /web_plan/republish at boot — a later
        // manual click can still request the zone list normally.
        if (!this._selRestored) {
            this._selRestored = true;
            const remembered = uiPrefGet('vitulus_sel_program', '');
            if (remembered) {
                const idx = message.program_list.findIndex((p) => p.name === remembered);
                if (idx !== -1) {
                    const hadReq = this._zoneRequested;
                    this._zoneRequested = true;
                    try { this.show_program(idx); }
                    catch (e) { console.warn('[programs] restore selection failed:', e); }
                    this._zoneRequested = hadReq;
                }
            }
        }
    }
    draw_program_list() {
        let prog_list = [];
        this.program_list_msg.program_list.forEach(async (program, index) => {
            prog_list.push(new ProgramListItemTemplate(program, index));
        });
        this.program_list = prog_list;
        this.map_menu.div_menu_program_items_row.innerHTML = this.get_html();
    }
    get_html(){
        let prog_elements = "";
        this.program_list.forEach((program) => {
            prog_elements += program.element;
        });
        return prog_elements;
    }
    show_program(id){
        // console.log(id);
        const program = this.program_list_msg.program_list[id];
        // settings-persistence: remember the selection (by raw name) so a
        // reload re-selects the same program once the list arrives again.
        uiPrefSet('vitulus_sel_program', program.name);
        this.map_menu.btn_menu_program_show.innerText = 'Show';
        this.map_menu.span_menu_program_name.innerText = program.name.split(' (')[0];
        this.map_menu.span_menu_program_length.innerText = program.length;
        this.map_menu.span_menu_program_area.innerText = program.area;
        this.map_menu.span_menu_program_duration.innerText = program.last_duration_minutes;
        const map_name = program.map_name.split('***env*')[0];
        const map_env = program.map_name.split('***env*')[1];
        this.map_menu.span_menu_program_env.innerText = map_env;
        this.map_menu.span_menu_program_map.innerText = map_name;
        this.map_menu.span_menu_program_last_result.innerText = program.last_result;
        this.map_menu.inp_program_rpm.value = program.rpm !== undefined ? program.rpm : 0;
        this.map_menu.inp_program_cut_height.value = program.cut_height !== undefined ? program.cut_height : 0;
        this._setSpeedButtons(program.speed || 'mid');
        this.map_menu.chk_program_override_zone.checked = program.override_zone || false;
        // Editable program (rename / add / remove zones). Work on a COPY so edits
        // are only committed on Save; zone_list is cloned so removing a zone here
        // doesn't mutate the cached list before saving.
        this.selected_program = Object.assign({}, program, { zone_list: (program.zone_list || []).slice() });
        this._editing_new = false;
        if (this.map_menu.inp_program_name) this.map_menu.inp_program_name.value = program.name.split(' (')[0];
        this._renderProgramZones();
        this._ensureZones();
        //remove all markers
        Object.keys(this.paths_visualization.markerArrayClient.markers).forEach((key) => {
            this.paths_visualization.markerArrayClient.removeMarker(key);
        });

        this.map_menu.div_menu_program_detail_row.style.display = "flex";
    }
    _setSpeedButtons(speed){
        const active = 'btn btn-sm btn-secondary';
        const inactive = 'btn btn-sm btn-outline-secondary';
        this.map_menu.btn_program_speed_slow.className = speed === 'slow' ? active : inactive;
        this.map_menu.btn_program_speed_mid.className = speed === 'mid' ? active : inactive;
        this.map_menu.btn_program_speed_fast.className = speed === 'fast' ? active : inactive;
    }
    saveProgram(){
        const prg = this.selected_program;
        if (!prg) return;
        const speed = this.map_menu.btn_program_speed_slow.classList.contains('btn-secondary') ? 'slow'
            : this.map_menu.btn_program_speed_fast.classList.contains('btn-secondary') ? 'fast' : 'mid';
        const updated = Object.assign({}, prg, {
            rpm: parseInt(this.map_menu.inp_program_rpm.value) || 0,
            cut_height: parseInt(this.map_menu.inp_program_cut_height.value) || 0,
            speed: speed,
            override_zone: this.map_menu.chk_program_override_zone.checked,
        });
        // Update local cache immediately so switching away and back shows correct values
        const idx = this.program_list_msg.program_list.findIndex(p => p.name === prg.name);
        if (idx !== -1) {
            this.program_list_msg.program_list[idx] = updated;
        }
        this.selected_program = updated;
        this.topic_program_new.publish(new ROSLIB.Message(updated));
    }
    show_program_in_map(){
        if (this.map_menu.btn_menu_program_show.innerText === 'Show'){
            Object.keys(this.paths_visualization.markerArrayClient.markers).forEach((key) => {
                this.paths_visualization.markerArrayClient.removeMarker(key);
            });
            this.program_to_show_marker_Topic.publish(this.selected_program);
            this.map_menu.btn_menu_program_show.innerText = 'Hide';
        }
        // OR Hide marker
        else {
            this.program_to_show_marker_Topic.publish(new ROSLIB.Message({
                name: 'none'
            }));
            Object.keys(this.paths_visualization.markerArrayClient.markers).forEach((key) => {
                this.paths_visualization.markerArrayClient.removeMarker(key);
            });
            this.map_menu.btn_menu_program_show.innerText = 'Show';
        }
    }
    runProgram(program_name) {
        const msg = new ROSLIB.Message({
            data: program_name,
        });
        this.topic_program_select.publish(msg);
        // console.log(msg);
    }

    resumeProgram(program_name) {
        const msg = new ROSLIB.Message({
            data: program_name,
        });
        this.topic_program_resume.publish(msg);
        // console.log(msg);
    }

    stopProgram() {
        const msg = new ROSLIB.Message({
            data: true,
        });
        this.smach_stop_Topic.publish(msg);
    }

    resetSmach() {
        // Clears TERMINAL_ERROR / STOPPED in mower_smach back to Ready.
        // Not the same as Resume (which re-runs an unfinished program).
        const msg = new ROSLIB.Message({
            data: true,
        });
        this.smach_reset_Topic.publish(msg);
    }
}

// class RainAlert {
//     constructor(ros) {
//         this.ico_rain_ok = document.getElementById("ico_rain_ok");
//         this.ico_rain_warn = document.getElementById("ico_rain_warn");
//         this.ico_rain_danger = document.getElementById("ico_rain_danger");
//         this.rain_alert_topic = new ROSLIB.Topic({
//             ros: ros,
//             name: '/weather_alert/rain_alert',
//             messageType: 'weather_alert/RainAlert'
//         });
//     }
//     rain_alert_data(message){
//         if (message.rain_alert){
//             this.ico_rain_ok.style.setProperty('display', 'none');
//             this.ico_rain_warn.style.setProperty('display', 'block');
//             this.ico_rain_danger.style.setProperty('display', 'none');
//             // this.ico_rain.className = 'bi bi-cloud-rain-fill';
//             if (message.rain_now > 0){
//                 this.ico_rain_ok.style.setProperty('display', 'none');
//                 this.ico_rain_warn.style.setProperty('display', 'none');
//                 this.ico_rain_danger.style.setProperty('display', 'block');
//                 // this.ico_rain.className = 'bi bi-cloud-rain-heavy-fill';
//             }
//         }
//         else {
//                 this.ico_rain_ok.style.setProperty('display', 'block');
//                 this.ico_rain_warn.style.setProperty('display', 'none');
//                 this.ico_rain_danger.style.setProperty('display', 'none');

//         }
//     }
// }


// vitulus_ui R2 (2026-07-18) + R3 (2026-07-19): every user-visible "active map"
// display shows the mapping-v3 SERVED SITE identity ("site (raster)") whenever a
// site is being served - because that raster IS the displayed base map -
// relegating the legacy navi map name (GARDEN_...***env*OUTDOOR) to the tooltip.
// With no site served it falls back to the legacy name (old behaviour). Two
// independent, order-agnostic writers feed each registered element:
//   - /navi_manager/active_map subscribers stamp data-legacy
//     (map_view.js StatusBar.set_map_name + the active_map_Topic handler below;
//      map_edit.js)
//   - mapping.js's /mapping_manager/status handler stamps data-site
// This shared renderer recomputes visible text + title from both attributes,
// for every element registered in ACTIVE_MAP_NAME_ELS:
//   - #active_map_name       — the Map-tab drawer header
//   - #span_status_map_name  — the mini status-bar panel over the 3D map view
// Add new ids here (not a duplicated renderer) when another display shows the
// active map name.
window.ACTIVE_MAP_NAME_ELS = ['active_map_name', 'span_status_map_name'];
window.renderActiveMapName = function () {
    window.ACTIVE_MAP_NAME_ELS.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var site = el.getAttribute('data-site') || '';
        var mapping = el.getAttribute('data-mapping') || '';
        var legacy = el.getAttribute('data-legacy') || '';
        // The legacy rtabmap-era navi map name is NEVER shown as the headline
        // any more (octomap/rtabmap mapping retired 2026-07-19) — it survives
        // only as the hover tooltip. Priority: served site > running mapping
        // session > explicit 'no map served'.
        if (site) { el.textContent = site; el.title = legacy; }
        else if (mapping) { el.textContent = 'mapping: ' + mapping + '\u2026'; el.title = legacy; }
        else { el.textContent = 'no map served'; el.title = legacy; }
    });
};

// vitulus_ui: was `window.onload`; converted to a named initialiser so the
// merged single page can lazily start each view. Called by app.js on window load.
window.initMapView = function () {
    ros = new ROS();

    // Visual connection-status indicator (top-right pill).
    conn_status = new ConnectionStatus(ros);

     /**
     *  Camera view
     */
    camera_view = new CameraView(ros);


    /**
     *  3D view
     */
    viewer = new Viewer3D(ros);
    // vitulus_ui: expose the ros3d viewer so app.js can stop()/start() its render
    // loop when the map section is hidden (otherwise it keeps drawing at 60fps,
    // saturating the GPU together with the IMU/planner viewers).
    window.__ros3d_map = viewer.viewer;
    layout_man = new LayoutManager(viewer, camera_view);
    layout_man.is_portrait = screen.orientation.type === "portrait-primary" || screen.orientation.type === "portrait-secondary";
    layout_man.set_layout();

    viewer.changeViewerSize();
    viewer.updateCam();
    viewer.viewer.addObject(new THREE.AmbientLight(0x696969));

    // vitulus_ui TASK1 — DEFAULT MAP ORIENTATION: NORTH UP.
    // Guarantee a conventional top-down map view on a fresh load: camera looks
    // straight DOWN (-Z) from above the /map origin, with the world +Y axis
    // pointing UP on screen and +X pointing RIGHT. That is geometrically
    // north-up / east-right because the /map frame is UTM-grid aligned (within
    // ~0.1°): the aerial + rain layers place UTM north -> +Y and UTM east -> +X
    // (see mapping.js georef — group carries -yaw, N->y, E->x). There is NO
    // persisted camera state (nothing in localStorage restores azimuth/zoom), so
    // this simply pins the startup pose; the user can still orbit freely after,
    // and this runs BEFORE TfClient so its captured map_cam_* (used by the
    // map-follow reinit) inherit the same north-up pose. No-op on the WebGL-less
    // stub viewer (nothing is rendered there anyway).
    try {
        var _cam0 = viewer.viewer.camera;
        var _ctrl0 = viewer.viewer.cameraControls;
        if (_cam0 && _ctrl0 && _ctrl0.center && _cam0.up && _cam0.position) {
            _cam0.up.set(0, 1, 0);                 // world +Y is screen-up (north)
            _ctrl0.center.set(0, 0, 0);            // look at the /map origin
            _cam0.position.set(0, 0, 1000);        // straight above -> top-down
            _ctrl0.thetaDelta = 0;                 // clear any azimuth/elev/zoom
            _ctrl0.phiDelta = 0;                   //   deltas so update() derives
            _ctrl0.scale = 1;                      //   a clean top-down pose
            if (_cam0.lookAt) { _cam0.lookAt(_ctrl0.center); }
            if (_cam0.updateProjectionMatrix) { _cam0.updateProjectionMatrix(); }
        }
    } catch (e) { /* stub viewer / no controls — nothing to orient */ }

    // settings-persistence: restore the last map-view camera pose (position +
    // orbit center; camera.up stays the north-up (0,1,0) set above, so the
    // stored position offset reproduces azimuth/elevation/zoom exactly). Runs
    // BEFORE TfClient so the captured map_cam_* inherit the restored pose (the
    // map-follow reinit then returns here too). Malformed/absent -> north-up.
    try {
        var _camSaved = JSON.parse(uiPrefGet('vitulus_cam_map', 'null'));
        // 2026-08-16 fix: a NEAR-TOP-DOWN saved pose (e.g. captured around the
        // editor's top-down mode) restores into the orbit-control gimbal
        // singularity — Z-rotation stops working and tilt goes erratic (field
        // report). Reject degenerate poses; keep the default view instead.
        var _camOk = _camSaved && Array.isArray(_camSaved.p) && _camSaved.p.length === 3 &&
            Array.isArray(_camSaved.c) && _camSaved.c.length === 3 &&
            _camSaved.p.every(isFinite) && _camSaved.c.every(isFinite);
        if (_camOk) {
            var _hdx = _camSaved.p[0] - _camSaved.c[0];
            var _hdy = _camSaved.p[1] - _camSaved.c[1];
            var _hdz = Math.abs(_camSaved.p[2] - _camSaved.c[2]);
            if (Math.hypot(_hdx, _hdy) < 0.05 * Math.max(_hdz, 1e-6)) { _camOk = false; }
        }
        if (_camOk) {
            var _cam1 = viewer.viewer.camera;
            var _ctrl1 = viewer.viewer.cameraControls;
            _cam1.position.set(_camSaved.p[0], _camSaved.p[1], _camSaved.p[2]);
            _ctrl1.center.set(_camSaved.c[0], _camSaved.c[1], _camSaved.c[2]);
            if (_cam1.lookAt) { _cam1.lookAt(_ctrl1.center); }
            if (_cam1.updateProjectionMatrix) { _cam1.updateProjectionMatrix(); }
        }
    } catch (e) { /* malformed stored pose — keep the north-up default */ }

    tf_client = new TfClient(ros, viewer.viewer);
    tf_client.tfClientMap.subscribe('base_link', function(tf) {
        tf_client.follow_robot_set(viewer.viewer, tf);
    });

    // settings-persistence: remember the map-view camera pose (debounced) so a
    // reload restores the same pan/zoom/azimuth. Only user-driven map-mode
    // orbiting is saved — robot-follow camera motion tracks the robot and is
    // not a user viewpoint choice.
    try {
        var _camSaveTimer = null;
        viewer.viewer.cameraControls.addEventListener('change', function () {
            if (tf_client.follow_target !== 'map') { return; }
            // 2026-08-16: never capture the editor's top-down camera as the
            // user's map viewpoint (restoring it broke orbit rotation)
            var _dp = document.getElementById('div_map_detail');
            if (_dp && getComputedStyle(_dp).display !== 'none') { return; }
            clearTimeout(_camSaveTimer);
            _camSaveTimer = setTimeout(function () {
                var c = viewer.viewer.camera;
                var ct = viewer.viewer.cameraControls.center;
                uiPrefSet('vitulus_cam_map', JSON.stringify({
                    p: [c.position.x, c.position.y, c.position.z],
                    c: [ct.x, ct.y, ct.z],
                }));
            }, 500);
        });
    } catch (e) { /* stub viewer / no controls */ }
    // tf_client_dock = new TfClient(ros, viewer.viewer);

    laser_scan = new LaserScan(ros, tf_client.tfClientMap, viewer.viewer);

    viewer_grid = new ViewerGrid(viewer);

    interactive_markers = new InteractiveMarkers(ros.ros, tf_client.tfClientMap, viewer.viewer);
    viewer.viewer.cameraControls.addEventListener('touchstart', function(event3d) {
        interactive_markers.new_marker(event3d);
    });

    viewer.viewer.cameraControls.addEventListener('mousedown', function(event3d) {
        interactive_markers.new_marker(event3d);
    });

    clouds = new Clouds(ros.ros, tf_client.tfClientMap, viewer.viewer);

    robot_visualization = new RobotVisualization(ros.ros, tf_client.tfClientMap, viewer.viewer);



    /**
     *  Paths
     */

    paths_visualization = new PathsPointsVisualization(ros.ros, tf_client.tfClientMap, viewer.viewer);

    /**
     *  Robot control
     */

    icon_status = new IconStatus(ros);
    icon_status.icon_status_topic.subscribe(function (message) {
        icon_status.icon_data(message);
    });

    /// Motors
    motors_control = new MotorControl(ros.ros);
    motors_control.btn_motors_on.onclick = function() {
        motors_control.motors_on();
    };
    motors_control.btn_motors_off.onclick = function() {
        motors_control.motors_off();
    };
    motors_control.btn_motor_torque.onclick = function() {
        motors_control.pub_set_torque(value = parseFloat(motors_control.input_motor_torque.value));
        motors_control.input_motor_torque.value = "";
    };
    motors_control.get_torque_set_topic.subscribe(function (message) {
        motors_control.span_motor_torque.textContent = message.data.toFixed(2);
    });
    motors_control.front_left_wheel_state_topic.subscribe(function (message) {
        motors_control.motor1_data(message)
    });
    motors_control.rear_right_wheel_state_topic.subscribe(function (message) {
        motors_control.motor4_data(message)
    });
    motors_control.front_right_wheel_state_topic.subscribe(function (message) {
        motors_control.motor2_data(message)
    });
    motors_control.rear_left_wheel_state_topic.subscribe(function (message) {
        motors_control.motor3_data(message)
    });
    motors_control.motorPowerStateTopic.subscribe(function (message) {
        motors_control.motor_state_data(message)
    });

    lidar_control = new LidarControl(ros.ros);
    lidar_control.btn_menu_lidar_on.onclick = function() {
        lidar_control.start_lidar();
    };
    lidar_control.btn_menu_lidar_off.onclick = function() {
        lidar_control.stop_lidar();
    };
    lidar_control.icon_status_topic.subscribe(function (message) {
        lidar_control.status_data(message);
    });

    /// Rosbag
    rosbag_control = new RosbagControl(ros.ros);
    rosbag_control.btn_d435_rec_start.onclick = function() {
        rosbag_control.d435_start();
    };
    rosbag_control.btn_d435_rec_stop.onclick = function() {
        rosbag_control.d435_stop();
    };
    rosbag_control.btn_d435_rec_fps.onclick = function() {
        const fps = parseFloat(rosbag_control.input_d435_rec_fps.value);
        if (!isNaN(fps) && fps > 0) {
            rosbag_control.d435_set_fps(fps);
            rosbag_control.input_d435_rec_fps.value = "";
        }
    };
    rosbag_control.d435_status_topic.subscribe(function(message) {
        rosbag_control.d435_status_data(message);
    });
    rosbag_control.btn_gnss_rec_start.onclick = function() {
        rosbag_control.gnss_start();
    };
    rosbag_control.btn_gnss_rec_stop.onclick = function() {
        rosbag_control.gnss_stop();
    };
    rosbag_control.gnss_status_topic.subscribe(function(message) {
        rosbag_control.gnss_status_data(message);
    });

    /// Rosbag — stored bag management (HTTP, not ROS)
    bag_manager = new BagManager();
    bag_manager.init();

    /**
     *  Status bar
     */

    status_bar = new StatusBar(ros.ros);

    function update_status_bar_info(text) {
        status_bar.set_status_info_text(text);
        status_bar.info_timeout = setTimeout(status_bar.hide_status_info, status_bar.timeout);
    }

    status_bar.nextion_log_info_Topic.subscribe(function (message) {
        update_status_bar_info(message.data);
    });
    status_bar.active_map_Topic.subscribe(function (message) {
        status_bar.set_map_name(message);
        // Keep the Map-menu "Active map" label + the "Save map as" input in sync
        // with the current map, independent of whether the map editor has been
        // opened (map_edit.js only runs once the detail panel is opened).
        try {
            var parts = (message.data || '').split('***env*');
            var name = parts[0] || '';
            var env = parts[1] || '';
            // vitulus_ui R2: stamp the legacy navi map name as data-legacy; the
            // shared renderer decides whether it shows in the header or falls to
            // the tooltip (when a mapping-v3 site is being served).
            var lbl = document.getElementById('active_map_name');
            if (lbl) {
                lbl.setAttribute('data-legacy', env ? (name + ' (' + env + ')') : name);
                if (window.renderActiveMapName) window.renderActiveMapName();
            }
            // Populate the "Save map as" input ONLY when the current map actually
            // changes (freshly loaded / newly created) — NOT on every status
            // update — otherwise it overwrites whatever the user is typing.
            var inp = document.getElementById('input_menu_map_new');
            if (inp && name !== status_bar._last_map_name) {
                status_bar._last_map_name = name;
                if (document.activeElement !== inp) {
                    inp.value = name;   // name only — no OUTDOOR/INDOOR suffix
                }
            }
        } catch (e) {}
    });
    status_bar.is_indoor_Topic.subscribe(function (message) {
        status_bar.set_indoor(message);
    });

    /**
     *  Occupancy maps
     */

    maps = new Maps(ros.ros, tf_client.tfClientMap, viewer.viewer);


    /**
     *  Menu
     */

    map_menu = new MapMenu(ros.ros, maps, status_bar);
    // vitulus_ui: expose so the in-view map editor (mapeditor.js) can switch the
    // map source to the planner and reuse the menu's panel machinery.
    window.map_menu = map_menu;
    // vitulus_ui Phase 1: relocate the menu panels into the left slide-out drawer.
    map_menu.install_drawer();

    /**
     *  Rtabmap
     */

    rtabmap = new RtabMap(ros.ros);
    rtabmap.rtabmap_status_topic.subscribe(function(message) {
         // console.log(message);
        if (message.data){
            rtabmap.div_rtabmap.style.visibility = "visible";
            rtabmap.is_rtabmap = true;
            rtabmap.rtabmap_loc_map_buttons_state();
        }
        else {
            rtabmap.div_rtabmap.style.visibility = "hidden";
            rtabmap.is_rtabmap = false;
            rtabmap.rtabmap_loc_map_buttons_state();
        }
    });
    rtabmap.rtabmap_info_Topic.subscribe(function(message) {
        rtabmap.set_info(message);
        rtabmap.rtabmap_loc_map_buttons_state();
        // console.log(message);
    });
    rtabmap.btn_menu_map_rtabmap_mapping.onclick = function () {
        rtabmap.set_rtabmap_mapping();

    }
    rtabmap.btn_menu_map_rtabmap_localization.onclick = function () {
        rtabmap.set_rtabmap_localization();
    }

    /**
    *  Odom
    */

    odom = new Odom(ros.ros);
    odom.odom_status_topic.subscribe(function(message) {
         odom.process_msg(message);
    });


     /**
     *  Programs
     */

    programs = new Programs(ros.ros, map_menu, paths_visualization);
    programs.reload_planner_data();

    /**
     *  Calendar Manager (scheduler calendar events)
     */
    calendarManager = new CalendarManager(ros.ros, programs);


    /**
     *  Submenu marker
     */
    map_menu.btn_marker.onclick = function () {
        map_menu.btn_marker_onclick(interactive_markers);
    };
    map_menu.range_marker_orientation.oninput = function() {
        const marker = viewer.viewer.scene.getObjectByName("webgui_marker");
        interactive_markers.euler.z = parseFloat(map_menu.range_marker_orientation.value);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromEuler(interactive_markers.euler);
        const rotate_z = viewer.viewer.scene.getObjectByName("rotate_z");
        marker.setOrientation(rotate_z, quaternion);
    };
    map_menu.btn_marker_send_goal.onclick = function () {
        map_menu.btn_marker_send_goal_onclick(interactive_markers);
    };

    map_menu.btn_marker_cancel_navigation.onclick = function () {
        map_menu.cancel_goal_publish();
    };

    /**
     *  Submenu settings
     */

    map_menu.btn_settings.onclick = function () {
        map_menu.btn_config_onclick(interactive_markers);
    };
    map_menu.btn_menu_lidar_on.onclick = function () {
        map_menu.btn_menu_lidar_on_onclick(lidar_control, true);
    };
    map_menu.btn_menu_lidar_off.onclick = function () {
        map_menu.btn_menu_lidar_on_onclick(lidar_control, false);
    };
    map_menu.btn_menu_rtabmap_lidar.onclick = function () {
        map_menu.rtabmap_sensor = "0";
        map_menu.rtabmap_apply();
    };
    map_menu.btn_menu_rtabmap_camera.onclick = function () {
        map_menu.rtabmap_sensor = "1";
        map_menu.rtabmap_apply();

    };
    map_menu.btn_menu_rtabmap_both.onclick = function () {
        map_menu.rtabmap_sensor = "2";
        map_menu.rtabmap_apply();
    };
    map_menu.input_range_rtabmap_distance.oninput = function() {
        map_menu.span_menu_rtabmap_distance_apply.innerText = map_menu.input_range_rtabmap_distance.value;
    };


    /**
     *  Points submenu
     */

    // map_menu.btn_points.onclick = function () {
    //     map_menu.btn_points_onclick(interactive_markers);
    // };
    map_menu.btn_menu_point_new_save.onclick = function () {
        map_menu.save_point();
    };
    map_menu.btn_menu_point_cancel.onclick = function () {
        map_menu.cancel_goal_publish()
    };
    map_menu.btn_menu_point_clear.onclick = function () {
        // console.log("btn_menu_point_clear");
        for (const [key, value] of Object.entries(paths_visualization.mapMarker.markers)) {
          value.visible = false;
        }
    };

    /**
     *  Programs submenu
     */

    map_menu.btn_programs.onclick = function () {
        map_menu.btn_programs_onclick(interactive_markers);
    };

    map_menu.btn_menu_program_show.onclick = function () {
        programs.show_program_in_map();
    };

    map_menu.btn_menu_program_run.onclick = function () {
        programs.runProgram(programs.selected_program.name);
    };

    map_menu.btn_menu_program_stop.onclick = function () {
        programs.stopProgram();
    };

    map_menu.btn_menu_program_reset.onclick = function () {
        programs.resetSmach();
    };

    map_menu.btn_menu_program_resume.onclick = function () {
        programs.resumeProgram(programs.selected_program.name);
    }

    map_menu.btn_program_speed_slow.onclick = function () {
        programs._setSpeedButtons('slow');
    };
    map_menu.btn_program_speed_mid.onclick = function () {
        programs._setSpeedButtons('mid');
    };
    map_menu.btn_program_speed_fast.onclick = function () {
        programs._setSpeedButtons('fast');
    };
    map_menu.btn_program_save_settings.onclick = function () {
        programs.saveProgramEdit();
    };

    /**
     *  Paths submenu
     */

    // map_menu.btn_paths.onclick = function () {
    //     map_menu.btn_paths_onclick(interactive_markers);
    // };
    map_menu.btn_menu_path_new_save.onclick = function () {
        map_menu.save_path();
    };
    map_menu.btn_menu_path_auto.onclick = function () {
        map_menu.new_auto_path();
    };
    map_menu.btn_menu_path_stop_auto.onclick = function () {
        map_menu.stop_auto_path();
    };
    map_menu.btn_menu_path_clear.onclick = function () {
        // console.log("btn_menu_path_clear");
        map_menu.path_clicked_show('');
        paths_visualization.mapPath.sn.visible = false;
    };
    map_menu.btn_menu_path_cancel.onclick = function () {
        map_menu.cancel_goal_publish()
    };

    /**
     *  Map submenu
     */

    map_menu.btn_map.onclick = function () {
        map_menu.btn_map_onclick(interactive_markers);
    };
    map_menu.btn_menu_map_new_indoor.onclick = function () {
        map_menu.new_map('indoor');
        // map_menu.hide_all_submenu_divs();
    }
    map_menu.btn_menu_map_new_outdoor.onclick = function () {
        map_menu.new_map('outdoor');
        // map_menu.hide_all_submenu_divs();
    }

    map_menu.btn_menu_map_new_save.onclick = function () {
        map_menu.save_map();
    }
    map_menu.btn_menu_map_rtabmap_show.onclick = function () {
        map_menu.map_to_show = 'rtabmap';
        map_menu.show_rtabmap_map();
    }
    map_menu.btn_menu_map_planner_show.onclick = function () {
        map_menu.map_to_show = 'planner';
        map_menu.show_planner_map();
    }


     /**
     *  Camera show/hide
     */

    map_menu.btn_camera_show.onclick = function () {
        map_menu.camera_show(camera_view);
        layout_man.set_layout();
    };

    /**
     *  Follow robot
     */

    map_menu.btn_follow.onclick = function () {
        switch(tf_client.follow_target){
            case 'map':
                tf_client.map_cam_position.copy(viewer.viewer.camera.position);
                tf_client.map_cam_rotation.copy(viewer.viewer.camera.rotation);
                tf_client.map_cam_center.copy(viewer.viewer.cameraControls.center);
                tf_client.follow_target = 'robot';
                viewer.viewer.camera.position.z = tf_client.robot_cam_position.z;
                status_bar.set_follow_text("Robot");
                break;
            case 'robot':
                // vitulus_ui: the "Robot front" (chase) view was removed; the
                // toggle now cycles Map -> Robot (top-down) -> Map.
                tf_client.robot_cam_position.copy(viewer.viewer.camera.position);
                tf_client.follow_target = 'map';
                tf_client.map_reinit = true;
                status_bar.set_follow_text("Map");
                break;
        }
        uiPrefSet('vitulus_follow', tf_client.follow_target);
    };





    /**
     *  Joystick
     */
    map_menu.btn_joy.onclick = function () {
        map_menu.joy_show();
    };

    joy_teleop = new JoyTeleop(ros);

    joy_teleop.manager.on("move", function(evt, nipple) {
        let direction = nipple.angle.degree - 90;
        if (direction > 180) {
            direction = -(450 - nipple.angle.degree);
        }
        let nip_distance = (nipple.distance/(joy_teleop.joysize/2));
        let lin = Math.cos(direction / 57.29) * nip_distance * joy_teleop.speed_lin; // linear speed conversion
        let ang = Math.sin(direction / 57.29) * nip_distance * joy_teleop.speed_ang; // angular speed conversion
        joy_teleop.set_lin(lin);
        joy_teleop.set_ang(ang);
        joy_teleop.set_publish_joy(true);
    });
    joy_teleop.manager.on("end", function() {
        //moveAction(0, 0);
        joy_teleop.set_publish_joy(false);
        joy_teleop.set_lin(0);
        joy_teleop.set_ang(0);
    });
    setInterval(function() {joy_teleop.joy_pub_speed()}, 50)


    /**
     *  Move base control
     */

    move_base_control = new MoveBaseControl(ros.ros, joy_teleop);

    // vitulus_ui: dedicated publisher for the power-module motor switch, used by
    // the emergency stop to physically open the motor power switch in the PM.
    // NOTE: the older MotorControl.pmMotorSwitchTopic publishes to /set_motor_switch
    // which has NO subscriber (dead) — the live switch handled by /pm/vitulus_ups
    // is /pm/set_motor_switch. We keep this separate from the normal "motors off"
    // button so only the e-stop opens the PM switch.
    var pm_motor_switch_estop = new ROSLIB.Topic({
        ros: ros.ros,
        name: '/pm/set_motor_switch',
        messageType: 'std_msgs/Bool'
    });
    pm_motor_switch_estop.advertise();

    map_menu.btn_stop_all.onclick = function () {
        // vitulus_ui: full emergency stop. It is not enough to cut the wheels and
        // cancel the nav goal — every autonomous driver must be stopped too, or
        // re-enabling the motors would let a still-running mowing mission / dock
        // sequence immediately drive off again. Each action is wrapped in its own
        // try/catch so a failure in one still lets all the others fire (the whole
        // point of an e-stop is that every subsystem receives the stop command).

        // 1) Cancel the active navigation goal (move_base_flex exe_path).
        try { move_base_control.pub_cancel_goal(); }
        catch (e) { console.error('[stop_all] cancel nav goal failed:', e); }

        // 2) Cut traction motor power — wheels stop. (/base/motor_power = false)
        try { motors_control.motors_off(); }
        catch (e) { console.error('[stop_all] motors off failed:', e); }

        // 3) Stop the mowing mission state machine. (/mower_smach/stop = true)
        try { programs.stopProgram(); }
        catch (e) { console.error('[stop_all] stop mowing program failed:', e); }

        // 4) Stop the cutting blade. (/mower/set_motor_on = false)
        try { mower.pub_mower_set_motor_on(false); }
        catch (e) { console.error('[stop_all] mower blade off failed:', e); }

        // 5) Stop the docking state machine. (/dock_smach/stop = true)
        try {
            if (typeof dock !== 'undefined' && dock && dock.stop_smach_publisher) {
                dock.stop_smach_publisher.publish(new ROSLIB.Message({ data: true }));
            }
        } catch (e) { console.error('[stop_all] stop docking failed:', e); }

        // 6) Open the power-module motor switch. (/pm/set_motor_switch = false)
        try { pm_motor_switch_estop.publish(new ROSLIB.Message({ data: false })); }
        catch (e) { console.error('[stop_all] open PM motor switch failed:', e); }

        update_status_bar_info("Emergency stop");
    }

    move_base_control.checkbox_keyboard.onclick = function() {
        move_base_control.keyboard_teleop.working = !!this.checked;
    };

    move_base_control.pub_set_speed('moderate');
    move_base_control.btn_menu_speed_low.style.color = "#ffffff";
    move_base_control.btn_menu_speed_moderate.style.color = "#446de5";
    move_base_control.btn_menu_speed_fast.style.color = "#ffffff";
    move_base_control.btn_menu_speed_low_sm.style.color = "#ffffff";
    move_base_control.btn_menu_speed_moderate_sm.style.color = "#446de5";
    move_base_control.btn_menu_speed_fast_sm.style.color = "#ffffff";

    joy_teleop.speed_lin = move_base_control.speed_lin_current;
    joy_teleop.speed_ang = move_base_control.speed_ang_current;

    move_base_control.btn_menu_speed_fast.onclick = function () {
        move_base_control.btn_speed_fast_onclick();
    };
    move_base_control.btn_menu_speed_moderate.onclick = function () {
        move_base_control.btn_speed_moderate_onclick();
    };
    move_base_control.btn_menu_speed_low.onclick = function () {
        move_base_control.btn_speed_slow_onclick();
    };
    move_base_control.btn_menu_speed_fast_sm.onclick = function () {
        move_base_control.btn_speed_fast_onclick();
    };
    move_base_control.btn_menu_speed_moderate_sm.onclick = function () {
        move_base_control.btn_speed_moderate_onclick();
    };
    move_base_control.btn_menu_speed_low_sm.onclick = function () {
        move_base_control.btn_speed_slow_onclick();
    };


    function resize() {
        // vitulus_ui: no longer force div_container to window.innerWidth/innerHeight
        // in px here — that froze the container's box and defeated the CSS
        // `height: 100dvh` system on html/body (index.html) + the --app-vh
        // fallback (app.js), which is the dynamic-viewport-height mechanism meant
        // to track mobile address-bar collapse / on-screen keyboard. div_container
        // has no explicit CSS size of its own; it now sizes from its children
        // (menu_spacer + #div_content, which use vh-based CSS), same as before
        // this override existed. LayoutManager.set_layout() only reads
        // div_container.offsetWidth/offsetHeight (map_view.js ~3832) and writes
        // sizes to OTHER elements — it does not itself write inline px to
        // div_container, so nothing else needed changing here.
        // console.log("resize w :", window.innerWidth, " h :", window.innerHeight);
        layout_man.set_layout();
    }
    window.addEventListener('resize', function(event){
            resize();
    });
    resize();

    /**
     *  Log
     */

    log_panel = new LogPanel(ros);
    log_panel.attach(map_menu.div_log_view);
    ros_log = log_panel.rosLog;        // /rosout view (kept as global for the subscription below)
    status_log = log_panel.statusLog;  // cached status-message view
    ros_log.log_topic.subscribe(function (message) {
        ros_log.process_message(message);
    });
    status_log.subscribe();
    map_menu.btn_log.onclick = function () {
        if (map_menu.div_log_view.style.display === "block"){
            // hide entirely (also collapses if expanded)
            if (log_panel.expanded) log_panel.set_expanded(false);
            map_menu.div_log_view.style.display = "none";
            uiPrefSet('vitulus_hud_log', '0');
            layout_man.set_layout();
        }
        else {
            map_menu.div_log_view.style.display = "block";
            uiPrefSet('vitulus_hud_log', '1');
            log_panel.render_open();
            layout_man.set_layout();
        }
    };

    /**
     *  Maps, paths, points
     */
    map_list = new MapList(ros.ros, map_menu);
    point_list = new ItemList(ros.ros, map_menu, 'point');
    path_list = new ItemList(ros.ros, map_menu, 'path');

    /**
     *  Diagnostics
     */

    diag = new Diag(ros);
    diag.diag_topic.subscribe(function (message) {
        diag.diag_data(message, diag.diag_arr);
    });

    /**
     *  Mower
     */

    mower = new Mower(ros);
    mower.mower_status_topic.subscribe(function (message) {
        mower.mower_status(message);
    });


    mower.mower_config_print_topic.subscribe(function (message) {
        mower.paragraph_mower_config.innerHTML = message.data;
    });

    mower.btn_mower_on.onclick = function() {
        mower.pub_mower_set_power(value = true)
    };

    mower.btn_mower_off.onclick = function() {
        mower.pub_mower_set_power(value = false)
    };

    mower.btn_mower_left.onclick = function() {
        mower.pub_mower_set_dir(value = 'LEFT')
    };

    mower.btn_mower_right.onclick = function() {
        mower.pub_mower_set_dir(value = 'RIGHT')
    };

    mower.btn_mower_set_height.onclick = function() {
        mower.pub_mower_set_cut_height(value = parseFloat(mower.input_mower_cut_height.value));
        mower.input_mower_cut_height.value = "";
    };

    mower.btn_mower_set_rpm.onclick = function() {
        mower.pub_mower_set_motor_rpm(value = parseFloat(mower.input_mower_rpm.value));
        mower.input_mower_rpm.value = "";
    };

    mower.btn_mower_calibration.onclick = function() {
        mower.pub_mower_set_calibrate(value = true);
    };

    mower.btn_mower_home.onclick = function() {
        mower.pub_mower_set_home(value = true);
    };

    mower.btn_mower_start_motor.onclick = function() {
        mower.pub_mower_set_motor_on(value = true);
    };

    mower.btn_mower_stop_motor.onclick = function() {
        mower.pub_mower_set_motor_on(value = false);
    };

    mower.btn_mower_cmd1_send.onclick = function() {
        mower.pub_mower_set_cmd(value = mower.input_mower_cmd1.value);
    };

    mower.btn_mower_cmd2_send.onclick = function() {
        mower.pub_mower_set_cmd(value = mower.input_mower_cmd2.value);
    };

    mower.btn_mower_cmd3_send.onclick = function() {
        mower.pub_mower_set_cmd(value = mower.input_mower_cmd3.value);
    };

    mower.btn_mower_cmd4_send.onclick = function() {
        mower.pub_mower_set_cmd(value = mower.input_mower_cmd4.value);
    };


    /**
     *  Power module
     */

    power_module = new PowerModule(ros);
    // Battery % next to the dock bolt; colour mirrors the top monitoring battery
    // icon (device_state_publisher buckets): FULL/75 green, 50 yellow, 25/EMPTY red.
    var span_batt_pct = document.getElementById("span_batt_pct");
    function update_dock_battery_pct(message) {
        if (!span_batt_pct) return;
        var cap = message.battery_capacity;
        span_batt_pct.textContent = cap + '%';
        var color;
        if (cap > 50) color = 'var(--bs-success)';      // FULL, 75
        else if (cap > 25) color = 'var(--bs-warning)'; // 50
        else color = 'var(--bs-danger)';                // 25, EMPTY
        span_batt_pct.style.setProperty('color', color);
    }
    power_module.power_status_topic.subscribe(function(message) {
        power_module.status_data(message);
        update_dock_battery_pct(message);
    });

    power_module.btn_run_charge.onclick = function() {
        power_module.pub_set_charge_current_running(value = parseInt(power_module.input_run_charge.value),
        power_module.input_run_charge.value = ""
    )};

    power_module.btn_run_cutoff.onclick = function() {
        power_module.pub_set_precharge_current_running(value = parseInt(power_module.input_run_cutoff.value),
        power_module.input_run_cutoff.value = ""
    )};

    power_module.btn_standby_charge.onclick = function() {
        power_module.pub_set_charge_current_standby(value = parseInt(power_module.input_standby_charge.value),
        power_module.input_standby_charge.value = ""
    )};

    power_module.btn_standby_cutoff.onclick = function() {
        power_module.pub_set_precharge_current_standby(value = parseInt(power_module.input_standby_cutoff.value),
        power_module.input_standby_cutoff.value = ""
    )};

    power_module.btn_ext_temp.onclick = function() {
        power_module.pub_set_temp_setpoint(value = parseInt(power_module.input_ext_temp.value),
        power_module.input_ext_temp.value = ""
    )};

    power_module.btn_pcb_temp.onclick = function() {
        power_module.pub_set_temp2_setpoint(value = parseInt(power_module.input_pcb_temp.value),
        power_module.input_pcb_temp.value = ""
    )};

    power_module.btn_motor_on_pm.onclick = function() {power_module.pub_set_motor_switch(value = true)};
    power_module.btn_motor_off_pm.onclick = function() {power_module.pub_set_motor_switch(value = false)};
    power_module.btn_mower_on_pm.onclick = function() {power_module.pub_set_bat_out_switch(value = true)};
    power_module.btn_mower_off_pm.onclick = function() {power_module.pub_set_bat_out_switch(value = false)};

    power_module.btn_sleep_time_save.onclick = function() {
        const min = parseInt(power_module.input_sleep_time_min.value, 10);
        if (min > 0) { power_module.pub_set_sleep_time(min); }
    };
    power_module.btn_sleep_timed.onclick = function() { power_module.pub_start_sleep(); };
    power_module.btn_sleep_until_charged.onclick = function() { power_module.pub_sleep_until_charged(); };
    power_module.btn_standby_delay.onclick = function() {
        const sec = parseInt(power_module.input_standby_delay.value, 10);
        if (!isNaN(sec)) { power_module.pub_set_standby_delay(sec); }
    };
    power_module.btn_sleep_charged_offset.onclick = function() {
        const sec = parseInt(power_module.input_sleep_charged_offset.value, 10);
        if (!isNaN(sec)) { power_module.pub_set_charged_offset(sec); }
    };
    power_module.btn_standby_timeout_discharging.onclick = function() {
        const sec = parseInt(power_module.input_standby_timeout_discharging.value, 10);
        if (!isNaN(sec)) { power_module.pub_set_standby_timeout_discharging(sec); }
    };



    /**
     *  Rain alert
     */

    rain_alert = new RainAlert(ros.ros);
    rain_alert.rain_alert_topic.subscribe(function (message) {
        rain_alert.rain_alert_data(message);
    });

    /**
     *  Dock
     */

    dock = new Dock(ros.ros, tf_client.tfClientMap, viewer.viewer);
    // rain_alert.rain_alert_topic.subscribe(function (message) {
    //     rain_alert.rain_alert_data(message);
    // });

    /**
     *  Gloc — lidar global localization (Loc tab)
     */

    gloc = new Gloc(ros.ros);

    /**
     *  Mapping v3 — terrain & obstacle mapping (Map tab section)
     */

    mapping_v3 = new MappingV3(ros.ros, tf_client.tfClientMap, viewer.viewer);

    /**
     *  Global occupancy-map opacity sliders ("3D view layers" group).
     *  Two range inputs (0..100 %): whole-mesh "Maps opacity" and unknown-only
     *  "Unknown opacity", both persisted in localStorage and applied through the
     *  MapLayerOpacity manager. Grid clients register themselves as they are
     *  created (base map + local costmap in post_load(), site/live in mapping.js).
     */
    (function wireMapOpacitySliders() {
        var sMaps = document.getElementById('mapv3_maps_opacity');
        var sUnk = document.getElementById('mapv3_unknown_opacity');
        var vMaps = document.getElementById('mapv3_maps_opacity_val');
        var vUnk = document.getElementById('mapv3_unknown_opacity_val');
        if (sMaps) {
            // reflect the persisted value into the control on load
            sMaps.value = String(Math.round(MapLayerOpacity.maps_opacity * 100));
            if (vMaps) { vMaps.textContent = sMaps.value + '%'; }
            sMaps.addEventListener('input', function () {
                var pct = parseInt(sMaps.value, 10);
                if (vMaps) { vMaps.textContent = pct + '%'; }
                MapLayerOpacity.setMapsOpacity(pct / 100);
            });
        }
        if (sUnk) {
            sUnk.value = String(Math.round(MapLayerOpacity.unknown_frac * 100));
            if (vUnk) { vUnk.textContent = sUnk.value + '%'; }
            sUnk.addEventListener('input', function () {
                var pct = parseInt(sUnk.value, 10);
                if (vUnk) { vUnk.textContent = pct + '%'; }
                MapLayerOpacity.setUnknownFrac(pct / 100);   // debounced rebuild
            });
        }
    })();


    /**
     *  orientation control
     */


    window.matchMedia("(orientation: portrait)").addEventListener("change", e => {
        const portrait = e.matches;
        layout_man.is_portrait = portrait;
        layout_man.set_layout();
    });

    function post_load() {

        maps.local_costmap = new ROS3D.OccupancyGridClient({
            ros : ros.ros,
            tfClient: tf_client.tfClientMap,
            rootObject : viewer.viewer.scene,
            continuous: true,
            compression: 'cbor',
            // topic: 'navi_manager/local_costmap',
            // 2026-08-03: odom-framed costmapa se kresli pres map-framed relay
            topic: '/local_costmap_map_framed',
            color: {r:255,g:0,b:255},  // {r:0,g:255,b:255} gridmap, {r:255,g:0,b:255} loc costmap, {r:255,g:255,b:0} glob costmap
            opacity: 0.3,
            offsetPose: maps.local_costmap_offset,
        });
        maps.map = new ROS3D.OccupancyGridClient({
            ros : ros.ros,
            tfClient: tf_client.tfClientMap,
            rootObject : viewer.viewer.scene,
            continuous: true,
            topic: '/navi_manager/map',
            color: {r:0,g:255,b:255},  // {r:0,g:255,b:255} gridmap, {r:255,g:0,b:255} loc costmap, {r:255,g:255,b:0} glob costmap
            opacity: 0.7,
            offsetPose: maps.map_offset,
        });

        // vitulus_ui: register these two base grids with the global opacity
        // manager so the "Maps opacity" / "Unknown opacity" sliders drive them
        // (the mapping-v3 site_map + live obstacle_map register themselves in
        // mapping.js). See MapLayerOpacity at the top of this file.
        MapLayerOpacity.registerClient(maps.local_costmap, MapLayerOrder.COSTMAP);
        MapLayerOpacity.registerClient(maps.map, MapLayerOrder.BASE);

        // 2026-08-16 (user request): Base-map layer toggle — mainly to hide
        // the factory-fresh BOOTSTRAP scan (with no active map the base grid
        // IS the bootstrap). Persisted per browser; re-applied on every grid
        // rebuild via the client's 'change' event.
        (function () {
            var chk = document.getElementById('mapv3_chk_base');
            if (!chk) return;
            var KEY = 'vitulus_layer_base';
            try { chk.checked = localStorage.getItem(KEY) !== '0'; } catch (e) {}
            function applyBaseVis() {
                if (maps.map.sceneNode) maps.map.sceneNode.visible = chk.checked;
                else if (maps.map.currentGrid) maps.map.currentGrid.visible = chk.checked;
            }
            chk.addEventListener('change', function () {
                try { localStorage.setItem(KEY, chk.checked ? '1' : '0'); } catch (e) {}
                applyBaseVis();
            });
            maps.map.on('change', applyBaseVis);
            applyBaseVis();
        })();

        // Map editor V1/V3: expose the live local-costmap grid client and the
        // program/zone MarkerArray client so the map editor (mapeditor.js /
        // mapedits.js) can hide the costmap while editing and toggle the zone
        // outline geometry from the editor "Show:" chips — without re-rendering.
        window.__local_costmap_client = maps.local_costmap;
        try { window.__program_markers_client = paths_visualization.markerArrayClient; } catch (e) {}

        // Reload planner
        programs.reload_planner_data();

    }
    // programs.reload_planner_data();

    window.setTimeout(function(){post_load();}, 1000);

    // ---- settings-persistence: restore remembered view state (2026-08-15) ----
    // Runs LAST, after every control is wired. Everything here is pure client
    // view state — none of these restores publishes a ROS message.
    try {
        // HUD: on-screen joystick / camera preview / log panel visibility.
        if (uiPrefGet('vitulus_hud_joy', '0') === '1') { map_menu.joy_show(); }
        if (uiPrefGet('vitulus_hud_camera', '0') === '1') { map_menu.camera_show(camera_view); }
        if (uiPrefGet('vitulus_hud_log', '0') === '1') {
            map_menu.div_log_view.style.display = "block";
            log_panel.render_open();
            if (uiPrefGet('vitulus_log_expanded', '0') === '1') { log_panel.set_expanded(true); }
        }
        layout_man.set_layout();
        // Follow mode: default is 'map'; a remembered 'robot' replays the
        // toggle (identical side effects to a manual tap).
        if (uiPrefGet('vitulus_follow', 'map') === 'robot') { map_menu.btn_follow.onclick(); }
        // Drawer panel: replay the trigger-button click so all side effects
        // (interactive markers, drawer chrome, IMU render gating) stay
        // consistent. 'editor' is deliberately NOT restored — the map editor
        // has its own enter flow with robot-side interactions.
        var _openPanel = uiPrefGet('vitulus_open_panel', '');
        if (_openPanel === 'marker') { map_menu.btn_marker.onclick(); }
        else if (_openPanel === 'map') { map_menu.btn_map.onclick(); }
        else if (_openPanel === 'program') { map_menu.btn_programs.onclick(); }
        else if (_openPanel === 'config') { map_menu.btn_settings.onclick(); }
    } catch (e) { console.warn('[vitulus_ui] view-state restore failed:', e); }
}