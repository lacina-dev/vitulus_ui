/**
 * Logger utility for consistent logging
 */
const DockLogger = {
    debugging: false, // Set to true to enable debug logs
    
    debug: function(message, ...args) {
        if (this.debugging) {
            console.log(`[Dock] ${message}`, ...args);
        }
    },
    
    info: function(message, ...args) {
        console.info(`[Dock] ${message}`, ...args);
    },
    
    warn: function(message, ...args) {
        console.warn(`[Dock] ${message}`, ...args);
    },
    
    error: function(message, ...args) {
        console.error(`[Dock] ${message}`, ...args);
    }
};

/**
 * Throttle function to limit the rate of function calls
 */
function throttle(callback, delay) {
    let lastCall = 0;
    let timeoutId = null;
    
    return function(...args) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCall;
        
        if (timeSinceLastCall >= delay) {
            // Execute immediately
            lastCall = now;
            callback.apply(this, args);
        } else if (!timeoutId) {
            // Schedule for later
            timeoutId = setTimeout(() => {
                lastCall = Date.now();
                timeoutId = null;
                callback.apply(this, args);
            }, delay - timeSinceLastCall);
        }
    };
}

/**
 * Utility for safely handling DOM elements
 */
function safeDOM(element, callback) {
    if (element) {
        return callback(element);
    }
    return null;
}

function dockT(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }
// set a translated text that follows a language switch (data-i18n)
function dockTag(el, key) {
    if (window.VTI18n) { VTI18n.tag(el, key); } else { el.textContent = key; }
}
// one translated <span> for an innerHTML status line (re-translated on a switch)
function dockSpan(cls, key) {
    return '<span class="' + cls + '" data-i18n="' + key + '">' + dockT(key) + '</span>';
}
// a form error: {key, vars, reason (another error)} → text in the current language
function dockErrText(err) {
    if (!err) { return ''; }
    const v = Object.assign({}, err.vars || {});
    if (err.reason) { v.reason = dockErrText(err.reason); }
    return dockT(err.key, v);
}

class Dock {
    constructor(ros, tf_client, viewer) {
        // Store references for use in other methods
        this.viewer = viewer;
        this.ros = ros;
        this.tf_client = tf_client;
        this.currentMap = ""; // Add this to track the current map name
        this._formErr = {};   // last form error per kind (re-translated on a language switch)

        // Initialize UI buttons
        this.predock_btn_by_map = document.getElementById("predock_btn_by_map");
        this.dock_btn_by_map = document.getElementById("dock_btn_by_map");
        this.dock_btn_by_map_stop = document.getElementById("dock_btn_by_map-stop");
        this.dock_btn_by_intensity = document.getElementById("dock_btn_by_intensity");
        this.dock_btn_by_intensity_stop = document.getElementById("dock_btn_by_intensity-stop");
        this.undock_btn_by_intensity = document.getElementById("undock_btn_by_intensity");
        this.dock_btn_new_map = document.getElementById("dock_btn_new_map");
        this.dock_btn_edit_map = document.getElementById("dock_btn_edit_map");
        this.dock_btn_stop_mapping = document.getElementById("dock_btn_stop_mapping");
        this.dock_btn_undock_by_map = document.getElementById("dock_btn_undock_by_map");
        this.dock_check_enable_by_map = document.getElementById("dock_check_enable_by_map");
        this.dock_label_enable_by_map = document.getElementById("dock_label_enable_by_map");
        this.dock_check_enable_by_intensity = document.getElementById("dock_check_enable_by_intensity");
        this.dock_label_enable_by_intensity = document.getElementById("dock_label_enable_by_intensity");

        // Add the dock and undock update point buttons
        this.dock_update_point_btn = document.getElementById("map_dock_btn_update_point");
        this.undock_update_point_btn = document.getElementById("map_undock_btn_update_point");

        // Initialize new menu buttons
        this.dock_btn_menu_dock = document.getElementById("dock_btn_menu_dock");
        this.dock_btn_menu_undock = document.getElementById("dock_btn_menu_undock");
        this.dock_btn_menu_stop = document.getElementById("dock_btn_menu_stop");

        this.dockMapEnabled = false;
        this.dockIntensityEnabled = false;
        this.inDockPointSelectionMode = false;
        this.inUndockPointSelectionMode = false;

        // Get status and image elements
        this.dock_status_div = document.getElementById("dock_div_intensity_status");
        this.dock_map_status_div = document.getElementById("dock_div_map_status");
        this.dock_map_image_div = document.getElementById("dock_div_map_image");
        this.dock_intensity_image_div = document.getElementById("dock_div_intensity_image");

        // Initialize status and image displays to hidden by default
        if (this.dock_status_div) {
            this.dock_status_div.style.display = 'none';
        }
        if (this.dock_map_status_div) {
            this.dock_map_status_div.style.display = 'none';
        }
        if (this.dock_map_image_div) {
            this.dock_map_image_div.style.display = 'none';
        }
        if (this.dock_intensity_image_div) {
            this.dock_intensity_image_div.style.display = 'none';
        }

        this.dock_by_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_detector/dock',
            messageType : 'std_msgs/Int8'
        });
        this.dock_by_map_Topic.advertise();

        this.dock_by_intensity_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_detector/intensity/dock',
            messageType : 'std_msgs/Bool'
        });
        this.dock_by_intensity_Topic.advertise();

        this.undock_by_intensity_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/undock_intensity',
            messageType : 'std_msgs/Bool'
        });
        this.undock_by_intensity_Topic.advertise();

        this.undock_by_intensity_detector_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_detector/intensity/undock',
            messageType : 'std_msgs/Bool'
        });
        this.undock_by_intensity_detector_Topic.advertise();

        this.new_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_detector/new_map',
            messageType : 'std_msgs/Bool'
        });
        this.new_map_Topic.advertise();

        this.mapping_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_detector/mapping',
            messageType : 'std_msgs/Bool'
        });
        this.mapping_Topic.advertise();

        this.undock_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_detector/undock',
            messageType : 'std_msgs/Bool'
        });
        this.undock_Topic.advertise();

        this.enable_map_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_manager/enable_map',
            messageType : 'std_msgs/Bool'
        });
        this.enable_map_Topic.advertise();

        this.enable_intensity_Topic = new ROSLIB.Topic({
            ros : ros,
            name : '/dock_manager/enable_intensity',
            messageType : 'std_msgs/Bool'
        });
        this.enable_intensity_Topic.advertise();

        // Define topic for saving waypoints
        this.saveWaypointTopic = new ROSLIB.Topic({
            ros : ros,
            name : '/navi_manager/save_waypoint',
            messageType : 'std_msgs/String'
        });

        // Add new subscriber for intensity enabled status
        this.intensity_enabled_status_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_manager/intensity_enabled',
            messageType: 'std_msgs/Bool'
        });

        this.intensity_enabled_status_subscriber.subscribe(this.handleIntensityEnabledStatus.bind(this));

        // Initialize marker storage
        this.currentMapMarkers = new Set();
        this.currentIntensityMarkers = new Set();
        this.currentNavigationMarkers = new Set(); // New set for navigation markers

        this.markerArrayClientMapDock = null;

        // 2026-08-16 (user request): dock graphics ALWAYS above the mapping
        // layers — dedicated group + periodic renderOrder/depthTest sweep
        // (markers are created dynamically by the MarkerArrayClients).
        this.dockVizGroup = new THREE.Object3D();
        viewer.scene.add(this.dockVizGroup);
        var _dvg = this.dockVizGroup;
        // 2026-08-16 v3 (field report): the always-on-top change SURFACED the
        // stale latched dock markers in the middle of the garden (giant green
        // intensity cells + a rotated plane) — before, they were silently
        // buried under the map layers. The group is now visible ONLY while a
        // dock context is active: docked(0) / undocking(1) / docking(2).
        _dvg.visible = false;
        var _dvgStatus = new ROSLIB.Topic({
            ros: ros, name: '/dock_smach/dock_status',
            messageType: 'std_msgs/Int8'
        });
        _dvgStatus.subscribe(function (m) {
            var v = Number(m.data);
            _dvg.visible = (v === 0 || v === 1 || v === 2);
        });
        // 2026-08-16 v2 (flicker fix): the interval-only sweep left freshly
        // republished markers unstyled for up to 700 ms — visible blinking on
        // every marker update. Style IMMEDIATELY on each client's 'change'
        // event; materials are touched once (flag) so nothing churns per
        // sweep. A slow interval stays as a safety net only.
        function _styleDockViz() {
            _dvg.traverse(function (o) {
                o.renderOrder = 35;   // DOCK_VIZ: above DIRECT 21, below ROBOT 55
                var m = o.material;
                if (m && !m._dockStyled) {
                    m.depthTest = false;
                    m.depthWrite = false;
                    m.transparent = true;
                    m._dockStyled = true;
                }
            });
        }
        this._styleDockViz = _styleDockViz;
        setInterval(_styleDockViz, 3000);
        this.markerArrayClientIntensityDock = new ROS3D.MarkerArrayClient({
            ros: ros,
            rootObject: this.dockVizGroup,
            tfClient: tf_client,
            topic: "/dock_detector/intensity/visualization",
            path: '/',
            messageType: 'visualization_msgs/MarkerArray'
        });
        this.markerArrayClientIntensityDock.on('change', _styleDockViz);
        
        // Add new marker array client for navigation visualization
        this.markerArrayClientNavigation = null;

        this.dock_status_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_detector/intensity/status',
            messageType: 'vitulus_dock/DockingStatus'
        });

        this.dock_status_subscriber.subscribe(this.handleDockStatus.bind(this));

        // Add subscriber for dock program settings
        this.dock_program_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_manager/dock_program',
            messageType: 'vitulus_msgs/DockProgram'
        });
        this.dock_program_subscriber.subscribe(this.handleDockProgramSettings.bind(this));
        
        // Add subscriber for undock program settings
        this.undock_program_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_manager/undock_program',
            messageType: 'vitulus_msgs/DockProgram'
        });
        this.undock_program_subscriber.subscribe(this.handleUndockProgramSettings.bind(this));
        
        // Add publisher to request program settings
        this.send_programs_publisher = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_manager/send_programs',
            messageType: 'std_msgs/Bool'
        });
        this.send_programs_publisher.advertise();

        // Add new topic for stopping smach
        this.stop_smach_publisher = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_smach/stop',
            messageType: 'std_msgs/Bool'
        });
        this.stop_smach_publisher.advertise();

        this.dock_status_map_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_detector/status',
            messageType: 'vitulus_dock/DockStatusMap'
        });

        this.dock_status_map_subscriber.subscribe(this.handleDockMapStatus.bind(this));

        // Add new subscriber for map enabled status
        this.map_enabled_status_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_manager/map_enabled',
            messageType: 'std_msgs/Bool'
        });

        this.map_enabled_status_subscriber.subscribe(this.handleMapEnabledStatus.bind(this));

        // Subscriber for dock confirmed status (icon color)
        this.dock_icon_in_dock = document.getElementById("dock_icon_in_dock");
        this.is_in_dock_confirmed_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_manager/is_in_dock_confirmed',
            messageType: 'std_msgs/Bool'
        });
        this.is_in_dock_confirmed_subscriber.subscribe(this.handleIsInDockConfirmed.bind(this));

        // Localization seed status (dock-anchored pose seed on docking)
        this.dock_seed_status_div = document.getElementById("dock_div_seed_status");
        this.dock_seed_status_subscriber = new ROSLIB.Topic({
            ros: ros,
            name: '/dock_localization_seed/status',
            messageType: 'std_msgs/String'
        });
        this.dock_seed_status_subscriber.subscribe(this.handleDockSeedStatus.bind(this));

        this.initializeButtons();

        // language switch: redraw the texts drawn with dockT() that are not
        // refreshed by a continuous topic (form errors, button tooltips)
        if (window.VTI18n) {
            VTI18n.onChange(() => {
                ['dock', 'undock'].forEach((kind) => {
                    const fe = this._formErr[kind];
                    if (fe && fe.span && fe.span.isConnected) { fe.span.textContent = dockErrText(fe.err); }
                    if (fe && fe.btn) { fe.btn.title = dockT('docking.err.see_tab', {text: dockErrText(fe.err)}); }
                });
            });
        }
    }

    handleIsInDockConfirmed(message) {
        if (this.dock_icon_in_dock) {
            if (message.data) {
                vtTone(this.dock_icon_in_dock, 'ok');
            } else {
                vtTone(this.dock_icon_in_dock, 'muted');
            }
        }
    }

    handleDockSeedStatus(message) {
        if (!this.dock_seed_status_div) return;
        let s;
        try { s = JSON.parse(message.data); } catch (e) { return; }

        let badgeText, badgeColor;
        if (!s.docked) {
            badgeText = '—';
            badgeColor = 'muted';
        } else if (s.last_seed_unconfirmed) {
            badgeText = dockT('docking.seed.unconfirmed');
            badgeColor = 'warn';
        } else if (s.seeded_this_episode) {
            badgeText = dockT('docking.seed.ok');
            badgeColor = 'ok';
        } else {
            badgeText = dockT('docking.seed.waiting');
            badgeColor = 'muted';
        }

        let seedHtml = `
        <div>
            <span>${dockT('docking.seed.label')} <span class="vt-strong vt-tone-${badgeColor}">${badgeText}</span></span>
        </div>
        `;
        if (s.docked_waypoint_present === false) {
            seedHtml += `
        <div>
            <span class="vt-tone-err">${dockT('docking.seed.wp_missing')}</span>
        </div>
            `;
        }
        if (s.confirmed_age_s !== null && s.confirmed_age_s !== undefined) {
            seedHtml += `
        <div>
            <span>${dockT('docking.seed.confirmed_ago', {s: s.confirmed_age_s.toFixed(0)})}</span>
        </div>
            `;
        }

        // vitulus_ui: layout-jitter fix — /dock_localization_seed/status is a
        // continuous subscription (fires regardless of whether a detector is
        // enabled); skip the DOM write when the rendered content hasn't
        // actually changed so an unchanged status doesn't force a reflow.
        if (this.dock_seed_status_div.innerHTML !== seedHtml) {
            this.dock_seed_status_div.innerHTML = seedHtml;
        }
    }

    setupImageViewers() {
        const setupViewer = (divElement, topic) => {
            if (!divElement) {
                DockLogger.warn(`Cannot setup viewer for topic ${topic} - div element not found`);
                return null;
            }
            
            const serverName = window.location.hostname;
            const serverPort = "8080";
            
            const statusElement = document.createElement('div');
            statusElement.id = `mjpeg-status-${topic.replace(/\//g, '-')}`;
            statusElement.className = 'vt-overlay-badge';   // U1: look in vt_panel.css, state via data-state
            dockTag(statusElement, 'docking.img.connecting');
            
            divElement.classList.add('vt-overlay-host');
            divElement.appendChild(statusElement);
            
            let viewer = null;
            let intervalId = null;
            
            try {
                viewer = new MJPEGCANVAS.Viewer({
                    divID: divElement.id,
                    host: serverName,
                    port: serverPort,
                    width: 480,
                    height: 480,
                    topic: topic,
                    onLoad: () => {
                        DockLogger.debug(`MJPEG viewer connected for ${topic}`);
                        dockTag(statusElement, 'docking.img.connected');
                        statusElement.dataset.state = 'ok';
                    },
                    onError: (error) => {
                        DockLogger.error(`MJPEG viewer error for ${topic}:`, error);
                        dockTag(statusElement, 'docking.img.conn_error');
                        statusElement.dataset.state = 'err';
                    }
                });
                
                // Monitor for image updates
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach(() => {
                        dockTag(statusElement, 'docking.img.receiving');
                        statusElement.dataset.state = 'ok';
                        
                        // Update last image time
                        viewer.lastImageTime = Date.now();
                    });
                });
                
                try {
                    observer.observe(divElement, { 
                        childList: true, 
                        subtree: true,
                        attributes: true 
                    });
                } catch (e) {
                    DockLogger.error(`Failed to setup observer for ${topic}:`, e);
                }
                
                // Check for stale images
                intervalId = setInterval(() => {
                    if (viewer && viewer.lastImageTime && Date.now() - viewer.lastImageTime > 5000) {
                        dockTag(statusElement, 'docking.img.no_updates');
                        statusElement.dataset.state = 'warn';
                    }
                }, 1000);
                
                // Store interval for cleanup
                if (!this.intervalIds) {
                    this.intervalIds = [];
                }
                this.intervalIds.push(intervalId);
                
            } catch (e) {
                DockLogger.error(`Failed to create MJPEG viewer for ${topic}:`, e);
                dockTag(statusElement, 'docking.img.setup_error');
                statusElement.dataset.state = 'err';
                
                // Clear interval if it was created
                if (intervalId) {
                    clearInterval(intervalId);
                }
                return null;
            }
            
            return viewer;
        };

        // Setup both viewers
        this.intensityImageViewer = setupViewer(this.dock_intensity_image_div, '/dock_detector/intensity/image');
        this.mapImageViewer = setupViewer(this.dock_map_image_div, '/dock_detector/map_image');
        
        DockLogger.debug('Image viewers setup completed');
    }

    publish_navi_by_map(data) {
        let message = new ROSLIB.Message({
            data: data
        });
        this.dock_by_map_Topic.publish(message);
        // console.log('Published go to dock message:', message);
    }

    publish_navi_by_intensity(data) {
        let message = new ROSLIB.Message({
            data: data
        });
        this.dock_by_intensity_Topic.publish(message);
        // console.log('Published intensity dock message:', message);
    }

    publish_undock_by_intensity(data) {
        let message = new ROSLIB.Message({
            data: data
        });
        this.undock_by_intensity_Topic.publish(message);
        // console.log('Published intensity undock message:', message);
    }

    publish_undock_by_intensity_detector(data) {
        let message = new ROSLIB.Message({
            data: data
        });
        this.undock_by_intensity_detector_Topic.publish(message);
        // console.log('Published to /dock_detector/intensity/undock topic:', message);
    }

    handleDockStatus(message) {
        // Convert status to human readable format
        let dock_status = dockT('docking.phase.inactive');
        if (message.docking_requested) {
            switch(message.navigation_phase) {
                case 1:
                    dock_status = dockT('docking.phase.align');
                    break;
                case 2:
                    dock_status = dockT('docking.phase.approach');
                    break;
                case 3:
                    dock_status = dockT('docking.phase.align_dock');
                    break;
                case 4:
                    dock_status = dockT('docking.phase.final');
                    break;
                default:
                    dock_status = dockT('docking.phase.active');
            }
        }

        let statusHtml = `
        <div>
            <span>${dockT('docking.int.status', {status: dock_status})}</span>
        </div>
        <div>

            <span>${dockT('docking.int.collision', {value: message.collision_detected})}</span>
        </div>
        <div>
            <span>${dockT('docking.int.dock_yaw', {deg: (message.dock_angle * 180 / Math.PI).toFixed(1)})}</span>
        </div>
        <div>
            <span>x:${message.dock_x.toFixed(3)}, y:${message.dock_y.toFixed(3)}m </span>
        </div>
        `;


        if (this.dock_status_div) {
            // vitulus_ui: layout-jitter fix — /dock_detector/intensity/status
            // is a continuous subscription; skip identical writes.
            if (this.dock_status_div.innerHTML !== statusHtml) {
                this.dock_status_div.innerHTML = statusHtml;
            }
            // layout-jitter fix 2026-08-08: visibility of the 480px image div
            // is OWNED by handleIntensityEnabledStatus. This per-message
            // unconditional 'block' fought the enabled=false 'none' — the div
            // flapped block/none at status rate and everything below the
            // intensity buttons bounced up/down by the canvas height. Only
            // reveal here when intensity docking is enabled, and only touch
            // style when it actually changes (no needless reflow).
            if (this.dock_intensity_image_div && this.dockIntensityEnabled
                    && this.dock_intensity_image_div.style.display !== 'block') {
                this.dock_intensity_image_div.style.display = 'block';
            }
        }
    }

    handleDockMapStatus(message) {
        let mapStatusHtml = `
            <div >
                <div>
                    <span>${dockT('docking.map.mode', {mode: message.status_mode})}</span>
                    <span>${dockT('docking.map.scans', {scans: message.scan_count, points: message.total_points})}</span>
                    <span>${dockT('docking.map.path_points', {n: message.path_points_count})}</span>
                </div>
                <div>
                    <span>${dockT('docking.map.loc')}</span>
                    <span>${dockT('docking.map.score', {v: message.localization_score.toFixed(3)})}</span>
                    <span>${dockT('docking.map.best', {v: message.localization_best.toFixed(3)})}</span>
                    <span>${dockT('docking.map.last_update', {s: message.localization_last_time.toFixed(2)})}</span>
                </div>
                <div>
                    <span>${dockT('docking.map.robot_pos')}</span>
                    <span>X: ${message.robot_x.toFixed(3)} m</span>
                    <span>Y: ${message.robot_y.toFixed(3)} m</span>
                    <span>${dockT('docking.map.yaw', {deg: message.robot_yaw.toFixed(2)})}</span>
                </div>
                <div>
                    <span>${dockT('docking.map.nav')}</span>
                    <span>${message.nav_status}</span>
                    <span>(${message.nav_progress.toFixed(1)}%)</span>
                    <span>${dockT('docking.map.distance', {m: message.distance_to_goal.toFixed(2)})}</span>
                    <span>${dockT('docking.map.eta', {s: message.estimated_time.toFixed(1)})}</span>
                    ${message.nav_error ? `<span class="vt-tone-err">${dockT('docking.map.error', {error: message.nav_error})}</span>` : ''}
                </div>
            </div>
        `;

        if (this.dock_map_status_div) {
            // vitulus_ui: layout-jitter fix — /dock_detector/status is a
            // continuous subscription and message.nav_error toggling on/off
            // adds/removes a <span>, which can change the wrapped line count
            // between two messages; skip the write when content is unchanged
            // so an unrelated field (e.g. Est. time counting down) doesn't
            // force a needless reflow either.
            if (this.dock_map_status_div.innerHTML !== mapStatusHtml) {
                this.dock_map_status_div.innerHTML = mapStatusHtml;
            }
            // layout-jitter fix 2026-08-08: same block/none flap as the
            // intensity image div — visibility is OWNED by
            // handleMapEnabledStatus; reveal here only when map docking is
            // enabled and the style actually changes.
            if (this.dock_map_image_div && this.dockMapEnabled
                    && this.dock_map_image_div.style.display !== 'block') {
                this.dock_map_image_div.style.display = 'block';
            }
        }
    }

    // Add the handler for map enabled status
    handleMapEnabledStatus(message) {
        // console.log("Dock map enabled status:");
        if (this.dock_label_enable_by_map) {
            
            if (message.data === true) {
                // Catch changes in the checkbox state
                if (this.dockMapEnabled === false) {
                    // console.log("Dock map enabled, showing map and markers");
                    this.showDockMapAndMarkers();
                }
                vtTone(this.dock_label_enable_by_map, 'ok');
                dockTag(this.dock_label_enable_by_map, 'docking.map_enabled');
                this.dock_check_enable_by_map.checked = true;
                this.dockMapEnabled = true;
                
                // Show map status and image when enabled
                if (this.dock_map_status_div) {
                    this.dock_map_status_div.style.display = 'block';
                }
                if (this.dock_map_image_div) {
                    this.dock_map_image_div.style.display = 'block';
                }
            } else {
                // Catch changes in the checkbox state
                if (this.dockMapEnabled === true) {
                    // console.log("Dock map disabled, hiding map and markers");
                    this.hideDockMapAndMarkers();
                }
                vtTone(this.dock_label_enable_by_map, 'muted');
                dockTag(this.dock_label_enable_by_map, 'docking.map_disabled');
                this.dock_check_enable_by_map.checked = false;
                this.dockMapEnabled = false;
                
                // Hide map status and image when disabled
                if (this.dock_map_status_div) {
                    this.dock_map_status_div.style.display = 'none';
                }
                if (this.dock_map_image_div) {
                    this.dock_map_image_div.style.display = 'none';
                }
            }
        }
    }

    // Add the handler for intensity enabled status
    handleIntensityEnabledStatus(message) {
        // console.log("Dock intensity enabled status:");
        if (this.dock_label_enable_by_intensity) {
            
            if (message.data === true) {
                // Catch changes in the checkbox state
                if (this.dockIntensityEnabled === false) {
                    // console.log("Dock intensity enabled, showing intensity markers");
                    this.showDockIntensityMarkers();
                }
                vtTone(this.dock_label_enable_by_intensity, 'ok');
                dockTag(this.dock_label_enable_by_intensity, 'docking.int_enabled');
                this.dock_check_enable_by_intensity.checked = true;
                this.dockIntensityEnabled = true;
                
                // Show intensity status and image when enabled
                if (this.dock_status_div) {
                    this.dock_status_div.style.display = 'block';
                }
                if (this.dock_intensity_image_div) {
                    this.dock_intensity_image_div.style.display = 'block';
                }
            } else {
                // Catch changes in the checkbox state
                if (this.dockIntensityEnabled === true) {
                    // console.log("Dock intensity disabled, hiding intensity markers");
                    this.hideDockIntensityMarkers();
                }
                vtTone(this.dock_label_enable_by_intensity, 'muted');
                dockTag(this.dock_label_enable_by_intensity, 'docking.int_disabled');
                this.dock_check_enable_by_intensity.checked = false;
                this.dockIntensityEnabled = false;
                
                // Hide intensity status and image when disabled
                if (this.dock_status_div) {
                    this.dock_status_div.style.display = 'none';
                }
                if (this.dock_intensity_image_div) {
                    this.dock_intensity_image_div.style.display = 'none';
                }
            }
        }
    }

    showDockMapAndMarkers() {
        // vitulus_ui: idempotency guard (mirrors markerArrayClientMapDock /
        // markerArrayClientNavigation below). Previously this unconditionally
        // created a new ROS3D.OccupancyGridClient (== a new /dock_detector/map
        // subscription) on every call; hideDockMapAndMarkers only removed the
        // old client's scene node without disposing its GPU geometry/material/
        // texture, so repeated show/hide cycles leaked. Now a client is created
        // once and reused; hideDockMapAndMarkers disposes + nulls it so the
        // next show() here recreates cleanly.
        if (!this.dockMapClient) {
            // Create new dock map client with standard configuration.
            // NOTE: opacity must be < 1.0. The ROS3D.OccupancyGrid constructor sets
            // material.transparent = (opacity < 1.0); with opacity 1.0 the material
            // is OPAQUE, so THREE ignores the per-pixel texture alpha entirely and
            // this 800x800 grid — which is ~67 % UNKNOWN (-1) cells — renders as a
            // solid dark-grey rectangle covering the whole dock-map extent. Because
            // this client shares the map_view 3D scene, that rectangle sat on top of
            // the real maps and could not be faded by the global opacity sliders.
            // Using 0.99 keeps it visually full-strength while making the material
            // transparent so both (a) the per-pixel unknown alpha from getColor()
            // and (b) the global "Maps opacity" slider (below) actually apply.
            this.dockMapClient = new ROS3D.OccupancyGridClient({
                ros: this.ros, // Use this.ros instead of ros
                rootObject: this.viewer.scene,
                topic: '/dock_detector/map',
                continuous: true,
                tfClient: this.tf_client, // Use this.tf_client instead of tf_client
                color: {r:0,g:255,b:255},  // {0,255,255} => base-map palette in getColor()
                opacity: 0.99,
                compression: "cbor",
                offsetPose: new ROSLIB.Pose({
                    position: new ROSLIB.Vector3({ x: 0, y: 0, z: -0.002 }),
                    orientation: new ROSLIB.Quaternion({ x: 0, y: 0, z: 0, w: 1.0 })
                })
            });

            // vitulus_ui: register the dock map with the global occupancy-opacity
            // manager (defined in map_view.js) so the "Maps opacity" / "Unknown
            // opacity" sliders drive it alongside the base map, costmap and the
            // mapping-v3 layers — it shares the same 3D scene. Guarded because
            // MapLayerOpacity only exists on pages that load map_view.js.
            try {
                if (typeof MapLayerOpacity !== 'undefined') {
                    MapLayerOpacity.registerClient(this.dockMapClient,
                        (typeof MapLayerOrder !== 'undefined') ? MapLayerOrder.DOCK : 30);
                }
            } catch (e) { /* opacity manager optional */ }
        }

        // Create or show marker array clients
        if (!this.markerArrayClientMapDock) {
            this.markerArrayClientMapDock = new ROS3D.MarkerArrayClient({
                ros: this.ros,
                rootObject: this.dockVizGroup,
                tfClient: this.tf_client,
                topic: "/dock_detector/basic_visualization_markers",
                path: '/',
                messageType: 'visualization_msgs/MarkerArray'
            });
            this.markerArrayClientMapDock.on('change', this._styleDockViz);
        }

        if (!this.markerArrayClientNavigation) {
            this.markerArrayClientNavigation = new ROS3D.MarkerArrayClient({
                ros: this.ros,
                rootObject: this.dockVizGroup,
                tfClient: this.tf_client,
                topic: "/dock_detector/navigation_visualization_markers",
                path: '/',
                messageType: 'visualization_msgs/MarkerArray'
            });
            this.markerArrayClientNavigation.on('change', this._styleDockViz);
        }

        // console.log("Dock map client and marker arrays created/shown with standard configuration");
    }

    hideDockMapAndMarkers() {
        // Remove previous dock map client if it exists
        if (this.dockMapClient) {
            // console.log("Removing dock map client");
            
            // First unsubscribe from the topic to stop receiving updates
            
            this.dockMapClient.unsubscribe();
            
            
            // Remove the currentGrid and its parent if they exist
            if (this.dockMapClient.currentGrid) {

                if (this.dockMapClient.currentGrid.parent) {
                    this.viewer.scene.remove(this.dockMapClient.currentGrid.parent);
                    // console.log("Removed currentGrid parent");
                }
                // Remove the grid itself
                this.viewer.scene.remove(this.dockMapClient.currentGrid);

                // vitulus_ui: free GPU resources (material + texture — see
                // ROS3D.OccupancyGrid.dispose() in ros3d.js). Removing from the
                // scene alone does not release them.
                if (typeof this.dockMapClient.currentGrid.dispose === 'function') {
                    this.dockMapClient.currentGrid.dispose();
                }
            }
            
            // Explicitly remove the rootObject
            if (this.dockMapClient.rootObject) {
                this.viewer.scene.remove(this.dockMapClient.rootObject);
            }
            
            // Force a render update to ensure visual changes take effect
            if (this.viewer.renderer) {
                this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);
            }
            
            // Clean up the reference
            this.dockMapClient = null;
        }
        
        // Clean up marker arrays - proper complete removal
        if (this.markerArrayClientMapDock) {
            // console.log("Removing markerArrayClientMapDock");
            // Unsubscribe from the topic
            if (this.markerArrayClientMapDock.rosTopic) {
                this.markerArrayClientMapDock.rosTopic.unsubscribe();
            }

            // Remove all markers from the scene
            if (this.markerArrayClientMapDock.rootObject && this.viewer.scene) {
                for (let marker in this.markerArrayClientMapDock.markers) {
                    this.viewer.scene.remove(this.markerArrayClientMapDock.markers[marker]);
                }
                this.viewer.scene.remove(this.markerArrayClientMapDock.rootObject);
            }
            
            this.markerArrayClientMapDock = null;
        }
        
        if (this.markerArrayClientNavigation) {
            // console.log("Removing markerArrayClientNavigation");
            // Unsubscribe from the topic
            if (this.markerArrayClientNavigation.rosTopic) {
                this.markerArrayClientNavigation.rosTopic.unsubscribe();
            }
            
            // Remove all markers from the scene
            if (this.markerArrayClientNavigation.rootObject && this.viewer.scene) {
                for (let marker in this.markerArrayClientNavigation.markers) {
                    this.viewer.scene.remove(this.markerArrayClientNavigation.markers[marker]);
                }
                this.viewer.scene.remove(this.markerArrayClientNavigation.rootObject);
            }
            
            this.markerArrayClientNavigation = null;
        }

        // console.log("Dock map client and marker arrays removed");
    }

    showDockIntensityMarkers() {
        // Create or show marker array client for intensity dock
        if (!this.markerArrayClientIntensityDock) {
            this.markerArrayClientIntensityDock = new ROS3D.MarkerArrayClient({
                ros: this.ros,
                rootObject: this.viewer.scene,
                tfClient: this.tf_client,
                topic: "/dock_detector/intensity/visualization",
                path: '/',
                messageType: 'visualization_msgs/MarkerArray'
            });
        }
        // console.log("Intensity dock markers shown");
    }

    hideDockIntensityMarkers() {
        // Clean up marker array - proper complete removal
        if (this.markerArrayClientIntensityDock) {
            // console.log("Removing markerArrayClientIntensityDock");
            
            // Unsubscribe from the topic
            if (this.markerArrayClientIntensityDock.rosTopic) {
                this.markerArrayClientIntensityDock.rosTopic.unsubscribe();
            }
            
            // Remove all markers from the scene
            if (this.markerArrayClientIntensityDock.rootObject && this.viewer.scene) {
                // First attempt to remove individual markers if they exist
                if (this.markerArrayClientIntensityDock.markers) {
                    for (let markerId in this.markerArrayClientIntensityDock.markers) {
                        const marker = this.markerArrayClientIntensityDock.markers[markerId];
                        if (marker && marker.parent) {
                            this.viewer.scene.remove(marker);
                        }
                    }
                }
                
                // Then remove the rootObject if it exists
                if (this.markerArrayClientIntensityDock.rootObject) {
                    this.viewer.scene.remove(this.markerArrayClientIntensityDock.rootObject);
                }
            }
            
            // Reset the client
            this.markerArrayClientIntensityDock = null;
            
            // Force a render update to ensure markers are removed visually
            if (this.viewer.renderer) {
                this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);
            }
        }
        // console.log("Intensity dock markers removed");
    }

    initializeButtons() {
        if (this.dock_btn_by_map) {
            this.dock_btn_by_map.addEventListener('click', () => {
                // console.log('Dock by map button pressed');
                this.publish_navi_by_map(1);
            });
        }

        if (this.predock_btn_by_map) {
            this.predock_btn_by_map.addEventListener('click', () => {
                // console.log('Predock by map button pressed');
                this.publish_navi_by_map(2);
            });
        }

        // Add handlers for the dock and undock navigation point buttons
        const dockNaviBtn = document.getElementById('map_dock_btn_navi_point');
        if (dockNaviBtn) {
            dockNaviBtn.addEventListener('click', () => {
                // console.log('Navigate to DOCK point button clicked');
                this.navigateToPoint("DOCK");
            });
        }
        
        const undockNaviBtn = document.getElementById('map_undock_btn_navi_point');
        if (undockNaviBtn) {
            undockNaviBtn.addEventListener('click', () => {
                // console.log('Navigate to UNDOCK point button clicked');
                this.navigateToPoint("UNDOCK");
            });
        }

        if (this.dock_btn_by_map_stop) {
            this.dock_btn_by_map_stop.addEventListener('click', () => {
                // console.log('Stop dock by map button pressed');
                this.publish_navi_by_map(0);
            });
        }

        if (this.dock_btn_by_intensity) {
            this.dock_btn_by_intensity.addEventListener('click', () => {
                // console.log('Dock by intensity button pressed');
                this.publish_navi_by_intensity(true);
            });
        }

        if (this.dock_btn_by_intensity_stop) {
            this.dock_btn_by_intensity_stop.addEventListener('click', () => {
                // console.log('Stop dock by intensity button pressed');
                this.publish_navi_by_intensity(false);
            });
        }

        if (this.undock_btn_by_intensity) {
            this.undock_btn_by_intensity.addEventListener('click', () => {
                // console.log('Undock by intensity button pressed');
                // Publish to both topics for compatibility
                this.publish_undock_by_intensity(true);
                // Also publish to the new /dock_detector/intensity/undock topic
                this.publish_undock_by_intensity_detector(true);
            });
        }

        if (this.dock_btn_new_map) {
            this.dock_btn_new_map.addEventListener('click', () => {
                // console.log('New map button pressed');
                let message = new ROSLIB.Message({
                    data: true
                });
                this.new_map_Topic.publish(message);
            });
        }

        if (this.dock_btn_edit_map) {
            this.dock_btn_edit_map.addEventListener('click', () => {
                // console.log('Edit map button pressed');
                let message = new ROSLIB.Message({
                    data: true
                });
                this.mapping_Topic.publish(message);
            });
        }

        if (this.dock_btn_stop_mapping) {
            this.dock_btn_stop_mapping.addEventListener('click', () => {
                // console.log('Stop mapping button pressed');
                let message = new ROSLIB.Message({
                    data: false
                });
                this.mapping_Topic.publish(message);
            });
        }

        if (this.dock_btn_undock_by_map) {
            this.dock_btn_undock_by_map.addEventListener('click', () => {
                // console.log('Undock by map button pressed');
                let message = new ROSLIB.Message({
                    data: true
                });
                this.undock_Topic.publish(message);
            });
        }

        if (this.dock_check_enable_by_map) {
            this.dock_check_enable_by_map.addEventListener('change', () => {
                // console.log('Enable map docking checkbox changed:', this.dock_check_enable_by_map.checked);
                if (this.dock_check_enable_by_map.checked) {
                    // Show dock map and markers
                    // this.showDockMapAndMarkers();
                } else {
                    // Hide dock map and markers
                    this.hideDockMapAndMarkers();
                }

                let message = new ROSLIB.Message({
                    data: this.dock_check_enable_by_map.checked
                });
                this.enable_map_Topic.publish(message);
            });
        }

        if (this.dock_check_enable_by_intensity) {
            this.dock_check_enable_by_intensity.addEventListener('change', () => {
                // console.log('Enable intensity docking checkbox changed:', this.dock_check_enable_by_intensity.checked);
                let message = new ROSLIB.Message({
                    data: this.dock_check_enable_by_intensity.checked
                });
                this.enable_intensity_Topic.publish(message);
            });
        }

        // Add handlers for the update dock and undock point buttons
        if (this.dock_update_point_btn) {
            this.dock_update_point_btn.addEventListener('click', () => {
                // console.log('Update dock point button clicked');
                this.addPoint("DOCK");
            });
        }

        if (this.undock_update_point_btn) {
            this.undock_update_point_btn.addEventListener('click', () => {
                // console.log('Update undock point button clicked');
                this.addPoint("UNDOCK");
            });
        }

        // Initialize topic
        this.saveWaypointTopic.advertise();

        // Initialize DockProgram publisher
        this.dockProgramPublisher = new ROSLIB.Topic({
            ros: this.ros,
            name: '/dock_smach/start_docking',
            messageType: 'vitulus_msgs/DockProgram'
        });
        this.dockProgramPublisher.advertise();

        // Initialize DockProgram save publisher
        this.saveDockProgramPublisher = new ROSLIB.Topic({
            ros: this.ros,
            name: '/dock_manager/save_dock_program',
            messageType: 'vitulus_msgs/DockProgram'
        });
        this.saveDockProgramPublisher.advertise();
        
        // Initialize UndockProgram save publisher
        this.saveUndockProgramPublisher = new ROSLIB.Topic({
            ros: this.ros,
            name: '/dock_manager/save_undock_program',
            messageType: 'vitulus_msgs/DockProgram'
        });
        this.saveUndockProgramPublisher.advertise();

        // Request current program settings from the dock manager
        setTimeout(() => {
            const sendProgramsMsg = new ROSLIB.Message({
                data: true
            });
            this.send_programs_publisher.publish(sendProgramsMsg);
            // console.log('Published request for current dock/undock programs');
        }, 1000); // Small delay to ensure all subscribers are ready

        // Add handlers for program dock and undock execute buttons
        const programDockBtn = document.getElementById('program_dock_btn_execute');
        if (programDockBtn) {
            programDockBtn.addEventListener('click', () => {
                // console.log('Dock program execute button pressed');
                const formErr = this._programFormError('dock');
                if (formErr) { this._showProgramFormError('dock', formErr); return; }
                const useMap = document.getElementById('program_dock_check_map').checked;
                const useDockMap = document.getElementById('program_dock_check_lidar_map').checked;
                const dockPath = document.getElementById('program_dock_select_lidar_path').value;
                const useIntensity = document.getElementById('program_dock_check_intensity').checked;
                const intensityAction = document.getElementById('program_dock_select_intesity_action').value;

                // Create the message
                const dockProgramMsg = new ROSLIB.Message({
                    header: {
                        stamp: {
                            secs: Math.floor(Date.now() / 1000),
                            nsecs: (Date.now() % 1000) * 1000000
                        },
                        frame_id: ''
                    },
                    use_map: useMap,
                    map: this.currentMap || '', // Use this.currentMap instead
                    map_dock_point: "dock",
                    use_dock_map: useDockMap,
                    path: dockPath,
                    use_intensity: useIntensity,
                    action: intensityAction
                });

                // Publish the message
                this.dockProgramPublisher.publish(dockProgramMsg);
                
                // Update status
                const statusDiv = document.getElementById('program_dock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = dockSpan('vt-tone-info', 'docking.prog.dock_started');
                }
            });
        }
        
        // Add handler for program dock save button
        const programDockSaveBtn = document.getElementById('program_dock_btn_save');
        if (programDockSaveBtn) {
            programDockSaveBtn.addEventListener('click', () => {
                // console.log('Dock program save button pressed');
                const formErr = this._programFormError('dock');
                if (formErr) { this._showProgramFormError('dock', formErr); return; }
                const useMap = document.getElementById('program_dock_check_map').checked;
                const useDockMap = document.getElementById('program_dock_check_lidar_map').checked;
                const dockPath = document.getElementById('program_dock_select_lidar_path').value;
                const useIntensity = document.getElementById('program_dock_check_intensity').checked;
                const intensityAction = document.getElementById('program_dock_select_intesity_action').value;

                // Create the message
                const dockProgramMsg = new ROSLIB.Message({
                    header: {
                        stamp: {
                            secs: Math.floor(Date.now() / 1000),
                            nsecs: (Date.now() % 1000) * 1000000
                        },
                        frame_id: ''
                    },
                    use_map: useMap,
                    map: this.currentMap || '',
                    map_dock_point: "dock",
                    use_dock_map: useDockMap,
                    path: dockPath,
                    use_intensity: useIntensity,
                    action: intensityAction
                });

                // Publish the message to save dock program
                this.saveDockProgramPublisher.publish(dockProgramMsg);
                this._requestProgramsSoon('dock');
                
                // Update status
                const statusDiv = document.getElementById('program_dock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = dockSpan('vt-tone-ok', 'docking.prog.dock_saved');
                }
            });
        }
        
        const programUndockBtn = document.getElementById('program_undock_btn_execute');
        if (programUndockBtn) {
            programUndockBtn.addEventListener('click', () => {
                // console.log('Undock program execute button pressed');
                const formErr = this._programFormError('undock');
                if (formErr) { this._showProgramFormError('undock', formErr); return; }
                const useMap = document.getElementById('program_predock_check_map').checked;
                const useDockMap = document.getElementById('program_predock_check_lidar_map').checked;
                const dockPath = document.getElementById('program_predock_select_lidar_path').value;
                const useIntensity = document.getElementById('program_predock_check_intensity').checked;
                const intensityAction = document.getElementById('program_predock_select_intesity_action').value;

                // Create the message
                const dockProgramMsg = new ROSLIB.Message({
                    header: {
                        stamp: {
                            secs: Math.floor(Date.now() / 1000),
                            nsecs: (Date.now() % 1000) * 1000000
                        },
                        frame_id: ''
                    },
                    use_map: useMap,
                    map: this.currentMap || '', // Use this.currentMap instead
                    map_dock_point: "undock",
                    use_dock_map: useDockMap,
                    path: dockPath,
                    use_intensity: useIntensity,
                    action: intensityAction
                });

                // Publish the message
                this.dockProgramPublisher.publish(dockProgramMsg);
                
                // Update status
                const statusDiv = document.getElementById('program_predock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = dockSpan('vt-tone-info', 'docking.prog.undock_started');
                }
            });
        }
        
        // Add handler for program undock save button
        const programUndockSaveBtn = document.getElementById('program_undock_btn_save');
        if (programUndockSaveBtn) {
            programUndockSaveBtn.addEventListener('click', () => {
                // console.log('Undock program save button pressed');
                const formErr = this._programFormError('undock');
                if (formErr) { this._showProgramFormError('undock', formErr); return; }
                const useMap = document.getElementById('program_predock_check_map').checked;
                const useDockMap = document.getElementById('program_predock_check_lidar_map').checked;
                const dockPath = document.getElementById('program_predock_select_lidar_path').value;
                const useIntensity = document.getElementById('program_predock_check_intensity').checked;
                const intensityAction = document.getElementById('program_predock_select_intesity_action').value;

                // Create the message
                const undockProgramMsg = new ROSLIB.Message({
                    header: {
                        stamp: {
                            secs: Math.floor(Date.now() / 1000),
                            nsecs: (Date.now() % 1000) * 1000000
                        },
                        frame_id: ''
                    },
                    use_map: useMap,
                    map: this.currentMap || '',
                    map_dock_point: "undock",
                    use_dock_map: useDockMap,
                    path: dockPath,
                    use_intensity: useIntensity,
                    action: intensityAction
                });

                // Publish the message to save undock program
                this.saveUndockProgramPublisher.publish(undockProgramMsg);
                this._requestProgramsSoon('undock');
                
                // Update status
                const statusDiv = document.getElementById('program_predock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = dockSpan('vt-tone-ok', 'docking.prog.undock_saved');
                }
            });
        }

        // Add handlers for new menu buttons
        if (this.dock_btn_menu_dock) {
            this.dock_btn_menu_dock.addEventListener('click', () => {
                // console.log('Menu Dock button pressed');
                const formErr = this._programFormError('dock');
                if (formErr) { this._showProgramFormError('dock', formErr, this.dock_btn_menu_dock); return; }
                const useMap = document.getElementById('program_dock_check_map').checked;
                const useDockMap = document.getElementById('program_dock_check_lidar_map').checked;
                const dockPath = document.getElementById('program_dock_select_lidar_path').value;
                const useIntensity = document.getElementById('program_dock_check_intensity').checked;
                const intensityAction = document.getElementById('program_dock_select_intesity_action').value;

                const dockProgramMsg = new ROSLIB.Message({
                    header: {
                        stamp: {
                            secs: Math.floor(Date.now() / 1000),
                            nsecs: (Date.now() % 1000) * 1000000
                        },
                        frame_id: ''
                    },
                    use_map: useMap,
                    map: this.currentMap || '',
                    map_dock_point: "dock",
                    use_dock_map: useDockMap,
                    path: dockPath,
                    use_intensity: useIntensity,
                    action: intensityAction
                });
                this.dockProgramPublisher.publish(dockProgramMsg);
                const statusDiv = document.getElementById('program_dock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = dockSpan('vt-tone-info', 'docking.prog.dock_started_menu');
                }
            });
        }

        if (this.dock_btn_menu_undock) {
            this.dock_btn_menu_undock.addEventListener('click', () => {
                // console.log('Menu Undock button pressed');
                const formErr = this._programFormError('undock');
                if (formErr) { this._showProgramFormError('undock', formErr, this.dock_btn_menu_undock); return; }
                const useMap = document.getElementById('program_predock_check_map').checked;
                const useDockMap = document.getElementById('program_predock_check_lidar_map').checked;
                const dockPath = document.getElementById('program_predock_select_lidar_path').value;
                const useIntensity = document.getElementById('program_predock_check_intensity').checked;
                const intensityAction = document.getElementById('program_predock_select_intesity_action').value;

                const undockProgramMsg = new ROSLIB.Message({
                    header: {
                        stamp: {
                            secs: Math.floor(Date.now() / 1000),
                            nsecs: (Date.now() % 1000) * 1000000
                        },
                        frame_id: ''
                    },
                    use_map: useMap,
                    map: this.currentMap || '',
                    map_dock_point: "undock",
                    use_dock_map: useDockMap,
                    path: dockPath,
                    use_intensity: useIntensity,
                    action: intensityAction
                });
                this.dockProgramPublisher.publish(undockProgramMsg);
                const statusDiv = document.getElementById('program_predock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = dockSpan('vt-tone-info', 'docking.prog.undock_started_menu');
                }
            });
        }

        if (this.dock_btn_menu_stop) {
            this.dock_btn_menu_stop.addEventListener('click', () => {
                // console.log('Menu Stop button pressed');
                const stopMsg = new ROSLIB.Message({
                    data: true
                });
                this.stop_smach_publisher.publish(stopMsg);
                // Optionally, update a status somewhere
                const dockStatusDiv = document.getElementById('program_dock_div_status');
                if (dockStatusDiv) {
                    dockStatusDiv.innerHTML = dockSpan('vt-tone-err', 'docking.prog.stop_sent_menu');
                }
                const undockStatusDiv = document.getElementById('program_predock_div_status');
                if (undockStatusDiv) {
                    undockStatusDiv.innerHTML = dockSpan('vt-tone-err', 'docking.prog.stop_sent_menu');
                }
            });
        }
    }

    // Method to navigate to a predefined point (DOCK or UNDOCK)
    navigateToPoint(pointName) {
        // Create a topic to publish the navigation goal point
        const naviGoalPointTopic = new ROSLIB.Topic({
            ros: this.ros,
            name: '/navi_manager/goal_point',
            messageType: 'std_msgs/String'
        });
        
        // Create and publish the message with the point name
        const message = new ROSLIB.Message({
            data: pointName
        });
        
        naviGoalPointTopic.publish(message);
        // console.log(`Navigation to ${pointName} point requested`);
        
        // Show confirmation message to the user
        const statusElement = document.getElementById('dock-point-status');
        if (statusElement) {
            statusElement.textContent = dockT('docking.point.navigating', {point: pointName});
            vtTone(statusElement, 'info');
            setTimeout(() => {
                statusElement.textContent = '';
            }, 5000);
        }
    }

    // Method to add a new point (DOCK or UNDOCK) using robot's current position
    addPoint(pointName) {
        // Create the message with the point name
        const savePointMsg = new ROSLIB.Message({
            data: pointName
        });

        // Publish the message to save the waypoint at current robot position
        this.saveWaypointTopic.publish(savePointMsg);

        // console.log(`Set ${pointName} point at current robot position`);
        
        // Show confirmation message to the user
        const statusElement = document.getElementById('dock-point-status');
        if (statusElement) {
            statusElement.textContent = dockT('docking.point.set', {point: pointName});
            vtTone(statusElement, 'ok');
            setTimeout(() => {
                statusElement.textContent = '';
            }, 5000);
        }
    }

    // Add a method to set the current map
    setCurrentMap(mapName) {
        this.currentMap = mapName;
        // console.log("Current map set to:", mapName);
    }

    // Add a method to handle dock program settings
    handleDockProgramSettings(message) {
        // console.log("Received dock program settings:", message);
        if (this._skipProgramRefresh('dock')) { return; }

        // Update form fields based on the received message
        const useMapCheckbox = document.getElementById('program_dock_check_map');
        const useDockMapCheckbox = document.getElementById('program_dock_check_lidar_map');
        const dockPathSelect = document.getElementById('program_dock_select_lidar_path');
        const useIntensityCheckbox = document.getElementById('program_dock_check_intensity');
        const intensityActionSelect = document.getElementById('program_dock_select_intesity_action');

        if (useMapCheckbox) {
            useMapCheckbox.checked = message.use_map;
        }
        if (useDockMapCheckbox) {
            useDockMapCheckbox.checked = message.use_dock_map;
        }
        if (useIntensityCheckbox) {
            useIntensityCheckbox.checked = message.use_intensity;
        }
        this._applySavedProgramSelects('dock', message, dockPathSelect, intensityActionSelect);

        // console.log("Dock program form fields updated");
    }

    // Add a method to handle undock program settings
    handleUndockProgramSettings(message) {
        // console.log("Received undock program settings:", message);
        if (this._skipProgramRefresh('undock')) { return; }

        // Update form fields based on the received message
        const useMapCheckbox = document.getElementById('program_predock_check_map');
        const useDockMapCheckbox = document.getElementById('program_predock_check_lidar_map');
        const dockPathSelect = document.getElementById('program_predock_select_lidar_path');
        const useIntensityCheckbox = document.getElementById('program_predock_check_intensity');
        const intensityActionSelect = document.getElementById('program_predock_select_intesity_action');

        if (useMapCheckbox) {
            useMapCheckbox.checked = message.use_map;
        }
        if (useDockMapCheckbox) {
            useDockMapCheckbox.checked = message.use_dock_map;
        }
        if (useIntensityCheckbox) {
            useIntensityCheckbox.checked = message.use_intensity;
        }
        this._applySavedProgramSelects('undock', message, dockPathSelect, intensityActionSelect);

        // console.log("Undock program form fields updated");
    }

    // ---- dock / undock program form rules (2026-09-20) -----------------------
    // dock_smach runs the UNDOCK branch (the only one that powers the motors)
    // only when the program holds a real undock step: intensity action UNDOCK,
    // or lidar map path UNDOCK. The Undock form used to default to action=DOCK /
    // path=PREDOCK with no validation, so a saved "undock" program could be a
    // docking program (robot sat in the dock, motors off, until a timeout).
    // The selects now offer only what makes sense per form, and Save / Execute
    // (and the bottom-bar Dock / Undock buttons) validate first.
    _programFormIds(kind) {
        const p = (kind === 'undock') ? 'program_predock_' : 'program_dock_';
        return {
            useMap: p + 'check_map',
            useDockMap: p + 'check_lidar_map',
            path: p + 'select_lidar_path',
            useIntensity: p + 'check_intensity',
            action: p + 'select_intesity_action',
            status: p + 'div_status'
        };
    }

    // '' when the form holds a valid program of its kind, else an error
    // {key, vars} for the user (dockErrText → text in the current language).
    // Messages are matched as keys, never as text.
    _programFormError(kind) {
        const ids = this._programFormIds(kind);
        const el = (id) => document.getElementById(id);
        const useMap = !!(el(ids.useMap) && el(ids.useMap).checked);
        const useDockMap = !!(el(ids.useDockMap) && el(ids.useDockMap).checked);
        const useIntensity = !!(el(ids.useIntensity) && el(ids.useIntensity).checked);
        const path = el(ids.path) ? el(ids.path).value : '';
        const action = el(ids.action) ? el(ids.action).value : '';
        if (!useMap && !useDockMap && !useIntensity) {
            return {key: 'docking.err.no_step'};
        }
        if (kind === 'undock') {
            if (useIntensity && action !== 'UNDOCK') return {key: 'docking.err.undock_action'};
            if (useDockMap && path !== 'UNDOCK' && path !== 'PREDOCK') return {key: 'docking.err.undock_path'};
            if (!((useIntensity && action === 'UNDOCK') || (useDockMap && path === 'UNDOCK'))) {
                return {key: 'docking.err.not_undock'};
            }
        } else {
            if (useIntensity && action !== 'DOCK') return {key: 'docking.err.dock_action'};
            if (useDockMap && path !== 'PREDOCK' && path !== 'DOCK') return {key: 'docking.err.dock_path'};
        }
        return '';
    }

    _showProgramFormError(kind, err, flashBtn) {
        const text = dockErrText(err);
        const statusDiv = document.getElementById(this._programFormIds(kind).status);
        const fe = this._formErr[kind] = {err: err, span: null, btn: (this._formErr[kind] || {}).btn || null};
        if (statusDiv) {
            statusDiv.innerHTML = '';
            const span = document.createElement('span');
            span.className = 'vt-tone-err';
            span.textContent = text;
            statusDiv.appendChild(span);
            fe.span = span;
        }
        console.warn('[dock] ' + kind + ' program not sent: ' + text);
        // Bottom-bar buttons: the Dock tab (with the message above) may be
        // closed, so also flash the button itself.
        if (flashBtn) {
            // ...and say why in the bottom status line (the same line that shows
            // the robot's /nextion/log_info messages; ~200 px wide on a phone,
            // hence the short text — the full reason is in the Dock tab).
            try {
                const sb = window.status_bar;
                if (sb && sb.set_status_info_text) {
                    sb.set_status_info_text(dockT(kind === 'undock' ? 'docking.bar.undock_invalid' : 'docking.bar.dock_invalid'));
                    clearTimeout(sb.info_timeout);
                    sb.info_timeout = setTimeout(() => sb.hide_status_info(), sb.timeout);
                }
            } catch (e) { /* status bar not up yet */ }
            flashBtn.title = dockT('docking.err.see_tab', {text: text});
            fe.btn = flashBtn;
            flashBtn.classList.remove('btn-primary'); flashBtn.classList.add('btn-danger');
            setTimeout(() => { flashBtn.classList.remove('btn-danger'); flashBtn.classList.add('btn-primary'); }, 2500);
        }
    }

    // A saved program may hold a value the restricted select no longer offers
    // (e.g. an old undock program with action=DOCK). Keep the form default then
    // and tell the user instead of leaving a blank select.
    _applySavedProgramSelects(kind, message, pathSelect, actionSelect) {
        const has = (sel, v) => !!sel && Array.prototype.some.call(sel.options, (o) => o.value === v);
        let badPath = null, badAction = null;
        if (pathSelect) {
            if (has(pathSelect, message.path)) pathSelect.value = message.path;
            else if (message.use_dock_map) badPath = message.path || dockT('docking.err.empty_value');
        }
        if (actionSelect) {
            if (has(actionSelect, message.action)) actionSelect.value = message.action;
            else if (message.use_intensity) badAction = message.action || dockT('docking.err.empty_value');
        }
        let err;
        if (badPath !== null && badAction !== null) err = {key: 'docking.err.uses_both', vars: {path: badPath, action: badAction}};
        else if (badPath !== null) err = {key: 'docking.err.uses_path', vars: {path: badPath}};
        else if (badAction !== null) err = {key: 'docking.err.uses_action', vars: {action: badAction}};
        else err = this._programFormError(kind);
        // An empty program (nothing saved yet on a new robot) is not worth a warning.
        const empty = !message.use_map && !message.use_dock_map && !message.use_intensity;
        if (err && !empty) {
            this._showProgramFormError(kind, {key: kind === 'undock' ? 'docking.err.saved_undock' : 'docking.err.saved_dock',
                reason: err});
        }
    }

    _skipProgramRefresh(kind) {
        const r = this._programRefreshOnly;
        return !!r && Date.now() < r.until && r.kind !== kind;
    }

    // After Save: ask dock_manager to re-publish its latched program topics
    // (older dock_manager versions saved without republishing, so the mission
    // kept reading the previous program).
    // send_programs re-publishes BOTH programs; unsaved edits in the OTHER form
    // of the tab must survive that, so for a short window only the saved kind
    // is applied to its form (see _skipProgramRefresh).
    _requestProgramsSoon(kind) {
        this._programRefreshOnly = { kind: kind, until: Date.now() + 3000 };
        setTimeout(() => {
            this.send_programs_publisher.publish(new ROSLIB.Message({ data: true }));
        }, 500);
    }
}
