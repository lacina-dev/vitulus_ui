/* vt_terrain_layer.js — map layer "Terrain (T10)" (T29, quick version 2026-11-08).
 *
 * What the robot's terrain node (traversability_local, vitulus_traversability,
 * T10) sees right now: its 6 × 6 m window around the robot, 5 cm cells, the
 * traversability cost 0 free … 99 hard, 100 not passable, -1 unknown — drawn
 * flat on the ground in the 3D map, over the maps, under the robot and paths.
 *
 * Data: /traversability/local_costmap_map_framed (nav_msgs/OccupancyGrid), the
 * node's /traversability/local_costmap re-framed odom -> map by a second
 * instance of nodes/costmap_reframe (the same relay the local costmap uses: the
 * bundled ros3d places odom-framed grids wrongly):
 *     rosrun vitulus_ui costmap_reframe _in:=/traversability/local_costmap \
 *         _out:=/traversability/local_costmap_map_framed __name:=costmap_reframe_t10
 * Next step (full T29): the richer /traversability/ui (reason, height,
 * contract ~/vitulus/predavka/t10-ui-kontrakt.md).
 *
 * Cost: subscribed ONLY while the layer is ticked and the page is visible,
 * throttle_rate 500 ms + queue_length 1 (at most 2 grids a second, CBOR);
 * one ros3d OccupancyGrid per message, as the local costmap. Nothing goes to
 * the robot (subscribe / unsubscribe only).
 *
 * Loaded by vt_map_layers.js (no change of index.html: static files only, no
 * webnode restart). Control: #mapv3_chk_trav in the Map tab's layers row
 * (remembered), mirrored by the layers panel; short state #mapv3_ov_trav_st.
 * Colours: a wrapper of ROS3D.OccupancyGrid.prototype.getColor for grids whose
 * color object carries vtTrav (map_view.js stays untouched).
 * Pure part tested in node: tools/test_terrain_layer.node.js. i18n: trav.*.
 */
(function (root) {
    'use strict';

    var TOPIC = '/traversability/local_costmap_map_framed';
    var THROTTLE_MS = 500;
    var NODATA_MS = 6000;      // ticked this long without a grid: the node sends nothing
    var STALE_MS = 3000;       // no new grid this long: old data
    var LS_ON = 'vitulus_layer_trav';

    // ---- pure ------------------------------------------------------------
    function lerp(a, b, f) { return Math.round(a + (b - a) * f); }
    function mix(c0, c1, f) { return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f), lerp(c0[3], c1[3], f)]; }
    // cost -> RGBA: 0 free = faint green, up to 49 green → yellow-green, 50–99
    // hard = yellow → orange, 100 not passable = red, unknown / other = clear
    function costColor(v) {
        if (v === 100) { return [229, 57, 53, 235]; }
        if (v === 0) { return [76, 175, 80, 90]; }
        if (v >= 1 && v <= 49) { return mix([76, 175, 80, 110], [192, 202, 51, 160], (v - 1) / 48); }
        if (v >= 50 && v <= 99) { return mix([255, 214, 0, 190], [255, 109, 0, 225], (v - 50) / 49); }
        return [0, 0, 0, 0];
    }
    // the layer's state from times (ms)
    function state(now, onAt, lastRx) {
        if (!onAt) { return 'off'; }
        if (!lastRx) { return (now - onAt > NODATA_MS) ? 'nodata' : 'wait'; }
        if (now - lastRx > NODATA_MS) { return 'nodata'; }
        if (now - lastRx > STALE_MS) { return 'stale'; }
        return 'ok';
    }

    var api = { costColor: costColor, state: state, TOPIC: TOPIC, THROTTLE_MS: THROTTLE_MS,
                NODATA_MS: NODATA_MS, STALE_MS: STALE_MS };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (typeof document === 'undefined') { if (root) { root.VTTerrain = api; } return; }

    // ---- browser -----------------------------------------------------------
    function t(k, v) { return root.VTI18n ? root.VTI18n.t(k, v) : k; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
    function $(id) { return document.getElementById(id); }
    function rosOf() { return (root.ros && root.ros.ros) || null; }
    function viewer3d() { return (root.viewer && root.viewer.viewer) || null; }
    function tfMap() { return (root.tf_client && root.tf_client.tfClientMap) || null; }

    var S = { chk: null, st: null, client: null, onAt: 0, lastRx: 0, rx: 0, timer: null, stateNow: 'off' };
    var COLOR = { r: 1, g: 2, b: 3, vtTrav: true };     // identifies this layer's grids in getColor

    // colours of this layer's grids; every other grid as before
    function wrapColors() {
        var P = root.ROS3D && ROS3D.OccupancyGrid && ROS3D.OccupancyGrid.prototype;
        if (!P || P._vtTravWrapped) { return !!P; }
        var orig = P.getColor;
        P.getColor = function (index, row, col, value) {
            if (this.color && this.color.vtTrav) { return costColor(value); }
            return orig.call(this, index, row, col, value);
        };
        P._vtTravWrapped = true;
        return true;
    }

    // ros3d's grid client, its topic throttled (the stock one has no throttle_rate)
    function makeClient() {
        var Base = ROS3D.OccupancyGridClient;
        function TravClient(o) { return Reflect.construct(Base, [o], TravClient); }
        TravClient.prototype = Object.create(Base.prototype);
        TravClient.prototype.constructor = TravClient;
        TravClient.prototype.subscribe = function () {
            this.unsubscribe();
            this.rosTopic = new ROSLIB.Topic({ ros: this.ros, name: this.topicName, messageType: 'nav_msgs/OccupancyGrid',
                                               queue_length: 1, compression: this.compression, throttle_rate: THROTTLE_MS });
            // keep the scene node of an earlier subscription (processMessage
            // re-targets it); stock subscribe() would orphan it
            if (this.sceneNode === undefined) { this.sceneNode = null; }
            this._boundProcessMessage = this.processMessage.bind(this);
            this.rosTopic.subscribe(this._boundProcessMessage);
        };
        Object.setPrototypeOf(TravClient, Base);
        var c = new TravClient({
            ros: rosOf(), tfClient: tfMap(), rootObject: viewer3d().scene, continuous: true, compression: 'cbor',
            topic: TOPIC, color: COLOR, opacity: 0.85,
            offsetPose: new ROSLIB.Pose({ position: new ROSLIB.Vector3({ x: 0, y: 0, z: 0.01 }),
                                          orientation: new ROSLIB.Quaternion({ x: 0, y: 0, z: 0, w: 1 }) }),
        });
        c.on('change', function () { S.lastRx = Date.now(); S.rx++; showGrid(true); tick(); });
        var MLO = (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder : null;
        // over the maps and the live / direct rasters, under sensing, paths and the robot
        var order = (MLO && MLO.DIRECT !== undefined ? MLO.DIRECT : 21) + 0.5;
        if (typeof MapLayerOpacity !== 'undefined' && MapLayerOpacity.registerClient) {
            MapLayerOpacity.registerClient(c, order);
        }
        return c;
    }
    function showGrid(on) {
        var c = S.client;
        if (!c) { return; }
        var n = c.sceneNode || c.currentGrid;
        if (n) { n.visible = on; }
    }

    function ensureControls() {
        if (S.chk) { return true; }
        var row = document.querySelector('.map-layers-row');
        if (!row) { return false; }
        var div = document.createElement('div');
        div.className = 'form-check form-check-inline vt-trav-ctl';
        div.setAttribute('data-i18n-title', 'trav.layer_tip');
        div.title = t('trav.layer_tip');
        div.innerHTML = '<input class="form-check-input" type="checkbox" id="mapv3_chk_trav">' +
            '<label class="form-check-label vt-fs-sm" for="mapv3_chk_trav"><span data-i18n="trav.layer">' + t('trav.layer') +
            '</span> <span class="vt-sw-trav">&#9632;</span></label><span id="mapv3_ov_trav_st" hidden></span>';
        row.appendChild(div);
        S.chk = $('mapv3_chk_trav'); S.st = $('mapv3_ov_trav_st');
        S.chk.checked = lsGet(LS_ON) === '1';
        S.chk.addEventListener('change', function () { lsSet(LS_ON, S.chk.checked ? '1' : '0'); sync(); });
        try { document.dispatchEvent(new CustomEvent('vt:map-sources')); } catch (e) { /* old browser */ }
        return true;
    }

    // subscribed only while ticked and visible
    function sync() {
        var want = !!(S.chk && S.chk.checked) && !document.hidden;
        if (want && rosOf() && viewer3d() && tfMap() && root.ROS3D && root.ROSLIB && wrapColors()) {
            if (!S.client) { S.client = makeClient(); S.onAt = Date.now(); S.lastRx = 0; }
            else if (!S.onAt) { S.client.subscribe(); S.onAt = Date.now(); S.lastRx = 0; }
        } else if (S.client && S.onAt) {
            // every listener off (MapLayerOpacity adds one to the topic too):
            // only then roslib sends rosbridge the unsubscribe
            try { if (S.client.rosTopic) { S.client.rosTopic.unsubscribe(); } } catch (e) { /* closed */ }
            S.onAt = 0;
        }
        if (!(S.chk && S.chk.checked)) { showGrid(false); }
        if (S.chk && S.chk.checked && !S.timer) { S.timer = setInterval(tick, 1000); }
        if (!(S.chk && S.chk.checked) && S.timer) { clearInterval(S.timer); S.timer = null; }
        tick();
    }

    function tick() {
        var on = !!(S.chk && S.chk.checked);
        var st = on ? (document.hidden ? 'paused' : !rosOf() ? 'noros' : state(Date.now(), S.onAt, S.lastRx)) : 'off';
        if (st === 'nodata') { showGrid(false); }
        var changed = st !== S.stateNow;
        S.stateNow = st;
        if (S.st) {
            var s = on ? t('trav.st.' + st) : '';
            if (S.st.textContent !== s) { S.st.textContent = s; }
        }
        if (changed) { try { document.dispatchEvent(new CustomEvent('vt:map-sources')); } catch (e) { /* old browser */ } }
    }

    function info() { return { state: S.stateNow, rx: S.rx, subscribed: !!(S.client && S.onAt) }; }

    function init() {
        if (!$('map_view')) { return; }
        var hook = setInterval(function () {
            if (!ensureControls()) { return; }
            if (!(rosOf() && viewer3d() && tfMap())) { return; }
            clearInterval(hook);
            sync();
        }, 500);
        document.addEventListener('visibilitychange', sync);
        if (root.VTI18n && root.VTI18n.onChange) { root.VTI18n.onChange(function () { S.stateNow = ''; tick(); }); }
    }

    api.info = info;
    api.sync = sync;
    api._S = S;
    root.VTTerrain = api;
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
    else { init(); }
})(typeof window !== 'undefined' ? window : this);
