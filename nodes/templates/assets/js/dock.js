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

class Dock {
    constructor(ros, tf_client, viewer) {
        // Store references for use in other methods
        this.viewer = viewer;
        this.ros = ros;
        this.tf_client = tf_client;
        this.currentMap = ""; // Add this to track the current map name

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

        this.markerArrayClientIntensityDock = new ROS3D.MarkerArrayClient({
            ros: ros,
            rootObject: viewer.scene,
            tfClient: tf_client,
            topic: "/dock_detector/intensity/visualization",
            path: '/',
            messageType: 'visualization_msgs/MarkerArray'
        });
        
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
    }

    handleIsInDockConfirmed(message) {
        if (this.dock_icon_in_dock) {
            if (message.data) {
                this.dock_icon_in_dock.style.color = 'var(--bs-success)';
            } else {
                this.dock_icon_in_dock.style.color = 'var(--bs-secondary)';
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
            badgeColor = 'gray';
        } else if (s.last_seed_unconfirmed) {
            badgeText = 'seeded (UNCONFIRMED)';
            badgeColor = 'orange';
        } else if (s.seeded_this_episode) {
            badgeText = 'seeded ✓';
            badgeColor = 'green';
        } else {
            badgeText = 'waiting';
            badgeColor = 'gray';
        }

        let seedHtml = `
        <div>
            <span>Seed: <span style="color:${badgeColor};font-weight:bold;">${badgeText}</span></span>
        </div>
        `;
        if (s.docked_waypoint_present === false) {
            seedHtml += `
        <div>
            <span style="color:red;">docked waypoint MISSING</span>
        </div>
            `;
        }
        if (s.confirmed_age_s !== null && s.confirmed_age_s !== undefined) {
            seedHtml += `
        <div>
            <span>confirmed ${s.confirmed_age_s.toFixed(0)}s ago</span>
        </div>
            `;
        }

        this.dock_seed_status_div.innerHTML = seedHtml;
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
            statusElement.style.position = 'absolute';
            statusElement.style.bottom = '10px';
            statusElement.style.right = '10px';
            statusElement.style.background = 'rgba(0,0,0,0.5)';
            statusElement.style.color = 'white';
            statusElement.style.padding = '5px 10px';
            statusElement.style.borderRadius = '3px';
            statusElement.style.fontSize = '12px';
            statusElement.textContent = 'Connecting...';
            
            divElement.style.position = 'relative';
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
                        statusElement.textContent = 'Connected';
                        statusElement.style.background = 'rgba(0,128,0,0.5)';
                    },
                    onError: (error) => {
                        DockLogger.error(`MJPEG viewer error for ${topic}:`, error);
                        statusElement.textContent = 'Connection Error';
                        statusElement.style.background = 'rgba(255,0,0,0.5)';
                    }
                });
                
                // Monitor for image updates
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach(() => {
                        statusElement.textContent = 'Receiving';
                        statusElement.style.background = 'rgba(0,128,0,0.5)';
                        
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
                        statusElement.textContent = 'No updates';
                        statusElement.style.background = 'rgba(255,165,0,0.5)';
                    }
                }, 1000);
                
                // Store interval for cleanup
                if (!this.intervalIds) {
                    this.intervalIds = [];
                }
                this.intervalIds.push(intervalId);
                
            } catch (e) {
                DockLogger.error(`Failed to create MJPEG viewer for ${topic}:`, e);
                statusElement.textContent = 'Setup Error';
                statusElement.style.background = 'rgba(255,0,0,0.5)';
                
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
        let dock_status = "INACTIVE";
        if (message.docking_requested) {
            switch(message.navigation_phase) {
                case 1:
                    dock_status = "ALIGN";
                    break;
                case 2:
                    dock_status = "APPROACH";
                    break;
                case 3:
                    dock_status = "ALIGN TO DOCK";
                    break;
                case 4:
                    dock_status = "FINAL APPROACH";
                    break;
                default:
                    dock_status = "ACTIVE";
            }
        }

        let statusHtml = `
        <div>
            <span>Status: ${dock_status}</span>
        </div>
        <div>

            <span>Collision Detected: ${message.collision_detected}</span>
        </div>
        <div>
            <span>Dock: yaw: ${(message.dock_angle * 180 / Math.PI).toFixed(1)}°,</span>
        </div>
        <div>
            <span>x:${message.dock_x.toFixed(3)}, y:${message.dock_y.toFixed(3)}m </span>
        </div>
        `;


        if (this.dock_status_div) {
            this.dock_status_div.innerHTML = statusHtml;
            // Add image container below status
            if (this.dock_intensity_image_div) {
                this.dock_intensity_image_div.style.display = 'block';
                this.dock_intensity_image_div.style.marginTop = '10px';
            }
        }
    }

    handleDockMapStatus(message) {
        let mapStatusHtml = `
            <div >
                <div>
                    <span>Mode: ${message.status_mode}</span>
                    <span>Scans: ${message.scan_count} / Points: ${message.total_points}</span>
                    <span>Path points: ${message.path_points_count}</span>
                </div>
                <div>
                    <span>Localization:</span>
                    <span>Score: ${message.localization_score.toFixed(3)}</span>
                    <span>Best: ${message.localization_best.toFixed(3)}</span>
                    <span>Last update: ${message.localization_last_time.toFixed(2)}s</span>
                </div>
                <div>
                    <span>Robot position:</span>
                    <span>X: ${message.robot_x.toFixed(3)} m</span>
                    <span>Y: ${message.robot_y.toFixed(3)} m</span>
                    <span>Yaw: ${message.robot_yaw.toFixed(2)}°</span>
                </div>
                <div>
                    <span>Navigation:</span>
                    <span>${message.nav_status}</span>
                    <span>(${message.nav_progress.toFixed(1)}%)</span>
                    <span>Distance: ${message.distance_to_goal.toFixed(2)} m</span>
                    <span>Est. time: ${message.estimated_time.toFixed(1)}s</span>
                    ${message.nav_error ? `<span style="color: red">Error: ${message.nav_error}</span>` : ''}
                </div>
            </div>
        `;

        if (this.dock_map_status_div) {
            this.dock_map_status_div.innerHTML = mapStatusHtml;
            // Add image container below status
            if (this.dock_map_image_div) {
                this.dock_map_image_div.style.display = 'block';
                this.dock_map_image_div.style.marginTop = '10px';
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
                this.dock_label_enable_by_map.style.color = 'green';
                this.dock_label_enable_by_map.textContent = 'Dock Map Enabled';
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
                this.dock_label_enable_by_map.style.color = 'gray';
                this.dock_label_enable_by_map.textContent = 'Dock Map Disabled';
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
                this.dock_label_enable_by_intensity.style.color = 'green';
                this.dock_label_enable_by_intensity.textContent = 'Dock Intensity Enabled';
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
                this.dock_label_enable_by_intensity.style.color = 'gray';
                this.dock_label_enable_by_intensity.textContent = 'Dock Intensity Disabled';
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
        // Remove previous dock map client if it exists
        if (this.dockMapClient && this.dockMapClient.rootObject) {
            this.viewer.scene.remove(this.dockMapClient.rootObject);
        }

        // Create new dock map client with standard configuration
        this.dockMapClient = new ROS3D.OccupancyGridClient({
            ros: this.ros, // Use this.ros instead of ros
            rootObject: this.viewer.scene,
            topic: '/dock_detector/map',
            continuous: true,
            tfClient: this.tf_client, // Use this.tf_client instead of tf_client
            color: {r:0,g:255,b:255},  // Pure blue color for better visibility
            opacity: 1.0,
            compression: "cbor",
            offsetPose: new ROSLIB.Pose({
                position: new ROSLIB.Vector3({ x: 0, y: 0, z: -0.002 }),
                orientation: new ROSLIB.Quaternion({ x: 0, y: 0, z: 0, w: 1.0 })
            })
        });

        // Create or show marker array clients
        if (!this.markerArrayClientMapDock) {
            this.markerArrayClientMapDock = new ROS3D.MarkerArrayClient({
                ros: this.ros,
                rootObject: this.viewer.scene,
                tfClient: this.tf_client,
                topic: "/dock_detector/basic_visualization_markers",
                path: '/',
                messageType: 'visualization_msgs/MarkerArray'
            });
        }

        if (!this.markerArrayClientNavigation) {
            this.markerArrayClientNavigation = new ROS3D.MarkerArrayClient({
                ros: this.ros,
                rootObject: this.viewer.scene,
                tfClient: this.tf_client,
                topic: "/dock_detector/navigation_visualization_markers",
                path: '/',
                messageType: 'visualization_msgs/MarkerArray'
            });
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
                    statusDiv.innerHTML = '<span style="color: #5bc0de;">Dock program started</span>';
                }
            });
        }
        
        // Add handler for program dock save button
        const programDockSaveBtn = document.getElementById('program_dock_btn_save');
        if (programDockSaveBtn) {
            programDockSaveBtn.addEventListener('click', () => {
                // console.log('Dock program save button pressed');
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
                
                // Update status
                const statusDiv = document.getElementById('program_dock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = '<span style="color: #28a745;">Dock program saved</span>';
                }
            });
        }
        
        const programUndockBtn = document.getElementById('program_undock_btn_execute');
        if (programUndockBtn) {
            programUndockBtn.addEventListener('click', () => {
                // console.log('Undock program execute button pressed');
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
                    statusDiv.innerHTML = '<span style="color: #5bc0de;">Undock program started</span>';
                }
            });
        }
        
        // Add handler for program undock save button
        const programUndockSaveBtn = document.getElementById('program_undock_btn_save');
        if (programUndockSaveBtn) {
            programUndockSaveBtn.addEventListener('click', () => {
                // console.log('Undock program save button pressed');
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
                
                // Update status
                const statusDiv = document.getElementById('program_predock_div_status');
                if (statusDiv) {
                    statusDiv.innerHTML = '<span style="color: #28a745;">Undock program saved</span>';
                }
            });
        }

        // Add handlers for new menu buttons
        if (this.dock_btn_menu_dock) {
            this.dock_btn_menu_dock.addEventListener('click', () => {
                // console.log('Menu Dock button pressed');
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
                    statusDiv.innerHTML = '<span style="color: #5bc0de;">Dock program started via menu</span>';
                }
            });
        }

        if (this.dock_btn_menu_undock) {
            this.dock_btn_menu_undock.addEventListener('click', () => {
                // console.log('Menu Undock button pressed');
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
                    statusDiv.innerHTML = '<span style="color: #5bc0de;">Undock program started via menu</span>';
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
                    dockStatusDiv.innerHTML = '<span style="color: #d9534f;">Stop signal sent via menu</span>';
                }
                const undockStatusDiv = document.getElementById('program_predock_div_status');
                if (undockStatusDiv) {
                    undockStatusDiv.innerHTML = '<span style="color: #d9534f;">Stop signal sent via menu</span>';
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
            statusElement.textContent = `Navigating to ${pointName} point`;
            statusElement.style.color = 'blue';
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
            statusElement.textContent = `${pointName} point set at current robot position`;
            statusElement.style.color = 'green';
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
        if (dockPathSelect) {
            dockPathSelect.value = message.path;
        }
        if (useIntensityCheckbox) {
            useIntensityCheckbox.checked = message.use_intensity;
        }
        if (intensityActionSelect) {
            intensityActionSelect.value = message.action;
        }

        // console.log("Dock program form fields updated");
    }

    // Add a method to handle undock program settings
    handleUndockProgramSettings(message) {
        // console.log("Received undock program settings:", message);

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
        if (dockPathSelect) {
            dockPathSelect.value = message.path;
        }
        if (useIntensityCheckbox) {
            useIntensityCheckbox.checked = message.use_intensity;
        }
        if (intensityActionSelect) {
            intensityActionSelect.value = message.action;
        }

        // console.log("Undock program form fields updated");
    }
}
