class RainAlert {
    constructor(ros) {
        this.ico_rain_ok = document.getElementById("ico_rain_ok");
        this.ico_rain_warn = document.getElementById("ico_rain_warn");
        this.ico_rain_danger = document.getElementById("ico_rain_danger");
        this.rain_map_div = document.getElementById("rain_div_map");
        this.rain_forecast_div = document.getElementById("rain_div_forecast");
        this.rain_div_report = document.getElementById("rain_div_report");
        
        this.hostname = location.hostname;
        
        // Setup placeholder text
        this.rain_map_div.innerHTML = '<div style="text-align: center; padding: 20px;"><i class="bi bi-cloud" style="font-size: 2rem;"></i><p>Waiting for map image...</p></div>';
        this.rain_forecast_div.innerHTML = '<div style="text-align: center; padding: 20px;"><i class="bi bi-cloud-sun" style="font-size: 2rem;"></i><p>Waiting for forecast image...</p></div>';
        this.rain_div_report.innerHTML = '<div style="text-align: center; padding: 20px;"><i class="bi bi-info-circle" style="font-size: 2rem;"></i><p>Waiting for weather alerts...</p></div>';
        
        // Subscribe to rain alert topic
        this.rain_alert_topic = new ROSLIB.Topic({
            ros: ros,
            name: '/weather_alert/rain_alert',
            messageType: 'weather_alert/RainAlert'
        });
        
        this.rain_alert_topic.subscribe((message) => {
            this.rain_alert_data(message);
            this.updateReportDiv(message);
        });
        
        // Add click event listeners to the icons
        this.addClickEventListeners();
        
        // Load images initially
        this.updateImages();
        
        // Set a refresh timer
        this.refreshTimer = setInterval(() => this.updateImages(), 30000); // 30 seconds
    }
    
    addClickEventListeners() {
        this.ico_rain_ok.addEventListener('click', () => this.handleIconClick('ok'));
        this.ico_rain_warn.addEventListener('click', () => this.handleIconClick('warn'));
        this.ico_rain_danger.addEventListener('click', () => this.handleIconClick('danger'));
    }
    
    handleIconClick(status) {
        // Refresh images when icon is clicked
        this.updateImages();
    }
    
    updateImages() {
        // Add timestamp to prevent caching
        const timestamp = new Date().getTime();

        const buildImg = (topic, container_w) => {
            const img = new Image();
            img.src = `http://${this.hostname}:8080/snapshot?topic=${topic}&t=${timestamp}`;
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
            img.style.display = 'block';
            img.style.cursor = 'zoom-in';
            img.title = 'Click to enlarge';
            img.addEventListener('click', () => this.openImageModal(topic));
            return img;
        };

        // Both map and forecast frames are 512×512 (the forecast is now a
        // 2×2 grid of nowcast frames sized to match NOW), so render them
        // at the same on-page width.
        const PANEL_WIDTH = '420px';

        // Map (NOW) image
        const mapImg = buildImg('/weather_alert/map_img', PANEL_WIDTH);
        mapImg.onload = () => {
            this.rain_map_div.innerHTML = '';
            const container = document.createElement('div');
            container.style.width = PANEL_WIDTH;
            container.style.maxWidth = '100%';
            container.style.margin = '0 auto';
            container.appendChild(mapImg);
            this.rain_map_div.appendChild(container);
        };
        mapImg.onerror = () => {
            this.rain_map_div.innerHTML = '<div style="text-align: center; padding: 20px;"><i class="bi bi-cloud-slash" style="font-size: 2rem;"></i><p>Map image unavailable</p></div>';
        };

        // Forecast image (2×2 grid, same pixel size as map)
        const forecastImg = buildImg('/weather_alert/forecast_img', PANEL_WIDTH);
        forecastImg.onload = () => {
            this.rain_forecast_div.innerHTML = '';
            const container = document.createElement('div');
            container.style.width = PANEL_WIDTH;
            container.style.maxWidth = '100%';
            container.style.margin = '0 auto';
            container.appendChild(forecastImg);
            this.rain_forecast_div.appendChild(container);
        };
        forecastImg.onerror = () => {
            this.rain_forecast_div.innerHTML = '<div style="text-align: center; padding: 20px;"><i class="bi bi-cloud-slash" style="font-size: 2rem;"></i><p>Forecast image unavailable</p></div>';
        };
    }

    openImageModal(topic) {
        // Lazily create a single full-screen modal that we reuse for both
        // the map and the forecast image.
        let modal = document.getElementById('rain-img-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rain-img-modal';
            Object.assign(modal.style, {
                position: 'fixed', top: '0', left: '0',
                width: '100vw', height: '100vh',
                background: 'rgba(0,0,0,0.85)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: '10000', cursor: 'zoom-out',
            });
            modal.addEventListener('click', () => { modal.style.display = 'none'; });
            document.body.appendChild(modal);
        }
        modal.innerHTML = '';
        const ts = new Date().getTime();
        const big = new Image();
        big.src = `http://${this.hostname}:8080/snapshot?topic=${topic}&t=${ts}`;
        Object.assign(big.style, {
            maxWidth: '95vw', maxHeight: '95vh',
            objectFit: 'contain', boxShadow: '0 0 20px #000',
            imageRendering: 'pixelated',
        });
        modal.appendChild(big);
        modal.style.display = 'flex';
    }
    
    updateReportDiv(message) {
        if (!message) {
            console.warn("Received empty message in updateReportDiv");
            return;
        }
        
        // Format the timestamp - check if header exists
        let formattedTimestamp = "Unavailable";
        if (message.time) {
            const timestamp = new Date(message.time.secs * 1000 + message.time.nsecs / 1000000);
            formattedTimestamp = timestamp.toLocaleString();
        }
        
        // Generate status message - default values if properties are undefined
        const rainAlert = message.rain_alert !== undefined ? message.rain_alert : false;
        const rainNow = message.rain_now !== undefined ? message.rain_now : 0;
        
        let statusMessage = rainAlert ? 
            (rainNow > 0 ? "Rain currently detected!" : "Rain alert - precipitation expected soon!") : 
            "No rain alerts at this time";
            
        // Safely get coordinates with fallbacks - using correct field names: lat and lon
        const latitude = message.lat !== undefined ? message.lat.toFixed(6) + "°" : "Unavailable";
        const longitude = message.lon !== undefined ? message.lon.toFixed(6) + "°" : "Unavailable";
        
        // Create the timeline visualization
        const timeline = this.createTimelineVisualization(message);
        
        // Create HTML content for report
        let reportHTML = `
            <div class="weather-report">
                <table class="table table-sm">
                    <tr>
                        <th>Status:</th>
                        <td><span class="${rainAlert ? (rainNow > 0 ? 'text-danger' : 'text-warning') : 'text-success'}">${statusMessage}</span></td>
                    </tr>
                    <tr>
                        <th>Rain Alert:</th>
                        <td>${rainAlert ? 'Yes' : 'No'}</td>
                    </tr>
                    <tr>
                        <th>Current Rain:</th>
                        <td>${rainNow > 0 ? 'Yes' : 'No'}</td>
                    </tr>
                    <tr>
                        <th>Location:</th>
                        <td>${message.location || 'Unavailable'}</td>
                    </tr>
                    <tr>
                        <th>Latitude:</th>
                        <td>${latitude}</td>
                    </tr>
                    <tr>
                        <th>Longitude:</th>
                        <td>${longitude}</td>
                    </tr>
                    <tr>
                        <th>Report Time:</th>
                        <td>${formattedTimestamp}</td>
                    </tr>
                </table>
                
                ${timeline}
            </div>
        `;
        
        // Update the div with formatted content
        this.rain_div_report.innerHTML = reportHTML;
    }
    
    createTimelineVisualization(message) {
        // Define status indicators and their corresponding CSS classes
        const statusClasses = {
            'OK': 'bg-success',
            'WARN': 'bg-warning',
            'ALERT': 'bg-danger',
            'RAIN': 'bg-info', // Changed to light blue (bg-info)
            'UNAVAILABLE': 'bg-secondary'
        };
        
        // Get status values with defaults
        const pastStatuses = [
            message.status_past60m || 'UNAVAILABLE',
            message.status_past50m || 'UNAVAILABLE',
            message.status_past40m || 'UNAVAILABLE',
            message.status_past30m || 'UNAVAILABLE',
            message.status_past20m || 'UNAVAILABLE',
            message.status_past10m || 'UNAVAILABLE'
        ];
        
        const currentStatus = message.status_now || 'UNAVAILABLE';
        
        const forecastStatuses = [
            message.status_nowcast10m || 'UNAVAILABLE',
            message.status_nowcast20m || 'UNAVAILABLE',
            message.status_nowcast30m || 'UNAVAILABLE'
        ];
        
        // Create the timeline HTML
        let timelineHTML = `
            <div class="timeline-container">
                <div class="timeline-section">
                    <div class="timeline-label">Past</div>
                    <div class="timeline-blocks">
                        ${this.createTimelineBlocks(pastStatuses, statusClasses, ['-60m', '-50m', '-40m', '-30m', '-20m', '-10m'])}
                    </div>
                </div>
                
                <div class="timeline-section">
                    <div class="timeline-label">Now</div>
                    <div class="timeline-blocks">
                        <div class="timeline-block-wrapper">
                            <div class="timeline-block ${statusClasses[currentStatus]}"></div>
                            <div class="timeline-time">0m</div>
                        </div>
                    </div>
                </div>
                
                <div class="timeline-section">
                    <div class="timeline-label">Forecast</div>
                    <div class="timeline-blocks">
                        ${this.createTimelineBlocks(forecastStatuses, statusClasses, ['+10m', '+20m', '+30m'])}
                    </div>
                </div>
            </div>
            
            <div class="timeline-legend mt-2">
                <div class="legend-item">
                    <div class="legend-color bg-success"></div>
                    <div class="legend-label">OK</div>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-warning"></div>
                    <div class="legend-label">WARN</div>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-danger"></div>
                    <div class="legend-label">ALERT</div>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-info"></div>
                    <div class="legend-label">RAIN</div>
                </div>
                <div class="legend-item">
                    <div class="legend-color bg-secondary"></div>
                    <div class="legend-label">UNAVAILABLE</div>
                </div>
            </div>
            
            <style>
                .timeline-container {
                    display: flex;
                    width: 100%;
                    margin: 10px 0;
                    border-radius: 5px;
                    padding: 10px;
                    background-color:rgba(8, 8, 8, 0.13);
                }
                
                .timeline-section {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                
                .timeline-label {
                    font-weight: bold;
                    font-size: 0.7rem;
                    margin-bottom: 5px;
                    text-align: center;
                }
                
                .timeline-blocks {
                    display: flex;
                    justify-content: space-around;
                    width: 100%;
                }
                
                .timeline-block-wrapper {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    margin: 0 2px;
                }
                
                .timeline-block {
                    width: 20px;
                    height: 20px;
                    border-radius: 3px;
                    margin: 2px;
                }
                
                .timeline-time {
                    font-size: 0.7rem;
                    color: #6c757d;
                }
                
                .timeline-legend {
                    display: flex;
                    justify-content: center;
                    flex-wrap: wrap;
                }
                
                .legend-item {
                    display: flex;
                    align-items: center;
                    margin: 0 10px;
                }
                
                .legend-color {
                    width: 15px;
                    height: 15px;
                    border-radius: 3px;
                    margin-right: 5px;
                }
                
                .legend-label {
                    font-size: 0.8rem;
                }
            </style>
        `;
        
        return timelineHTML;
    }
    
    createTimelineBlocks(statuses, statusClasses, labels) {
        let blocksHTML = '';
        
        for (let i = 0; i < statuses.length; i++) {
            const status = statuses[i];
            const label = labels[i];
            const cssClass = statusClasses[status] || 'bg-secondary';
            
            blocksHTML += `
                <div class="timeline-block-wrapper">
                    <div class="timeline-block ${cssClass}" title="${status}"></div>
                    <div class="timeline-time">${label}</div>
                </div>
            `;
        }
        
        return blocksHTML;
    }
    
    rain_alert_data(message){
        if (message.rain_alert){
            this.ico_rain_ok.style.setProperty('display', 'none');
            this.ico_rain_warn.style.setProperty('display', 'block');
            this.ico_rain_danger.style.setProperty('display', 'none');
            
            if (message.rain_now > 0){
                this.ico_rain_ok.style.setProperty('display', 'none');
                this.ico_rain_warn.style.setProperty('display', 'none');
                this.ico_rain_danger.style.setProperty('display', 'block');
            }
        }
        else {
            this.ico_rain_ok.style.setProperty('display', 'block');
            this.ico_rain_warn.style.setProperty('display', 'none');
            this.ico_rain_danger.style.setProperty('display', 'none');
        }
    }
}