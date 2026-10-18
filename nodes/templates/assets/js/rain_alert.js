function rainT(k, v) { return window.VTI18n ? VTI18n.t(k, v) : k; }

class RainAlert {
    constructor(ros) {
        this.ico_rain_ok = document.getElementById("ico_rain_ok");
        this.ico_rain_warn = document.getElementById("ico_rain_warn");
        this.ico_rain_danger = document.getElementById("ico_rain_danger");
        this.rain_map_div = document.getElementById("rain_div_map");
        this.rain_forecast_div = document.getElementById("rain_div_forecast");
        this.rain_div_report = document.getElementById("rain_div_report");
        // vitulus_ui R1 (2026-07-18): compact status shown right-aligned in the
        // "Weather report" <details> summary (so it reads while collapsed). Filled
        // by the same updateReportDiv() handler that builds the full report table.
        this.rain_report_status = document.getElementById("rain_report_status");

        this.hostname = location.hostname;
        
        // Setup placeholder text (tagged: follows a language switch)
        this.rain_map_div.innerHTML = '<div class="vt-empty vt-empty-big"><i class="bi bi-cloud"></i><p data-i18n="rainui.wait_map">' + rainT('rainui.wait_map') + '</p></div>';
        this.rain_forecast_div.innerHTML = '<div class="vt-empty vt-empty-big"><i class="bi bi-cloud-sun"></i><p data-i18n="rainui.wait_forecast">' + rainT('rainui.wait_forecast') + '</p></div>';
        this.rain_div_report.innerHTML = '<div class="vt-empty vt-empty-big"><i class="bi bi-info-circle"></i><p data-i18n="rainui.wait_alerts">' + rainT('rainui.wait_alerts') + '</p></div>';
        this.lastMessage = null;
        // language switch: rebuild the report from the last message
        if (window.VTI18n) {
            VTI18n.onChange(() => { if (this.lastMessage) { this.updateReportDiv(this.lastMessage); } });
        }
        
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
            img.className = 'vt-img vt-img-zoom';   // U1: vt_panel.css
            img.setAttribute('data-i18n-title', 'rainui.enlarge');
            img.title = rainT('rainui.enlarge');
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
            container.className = 'vt-img-frame';   // same width for NOW and forecast
            container.appendChild(mapImg);
            this.rain_map_div.appendChild(container);
        };
        mapImg.onerror = () => {
            this.rain_map_div.innerHTML = '<div class="vt-empty vt-empty-big"><i class="bi bi-cloud-slash"></i><p data-i18n="rainui.map_unavailable">' + rainT('rainui.map_unavailable') + '</p></div>';
        };

        // Forecast image (2×2 grid, same pixel size as map)
        const forecastImg = buildImg('/weather_alert/forecast_img', PANEL_WIDTH);
        forecastImg.onload = () => {
            this.rain_forecast_div.innerHTML = '';
            const container = document.createElement('div');
            container.className = 'vt-img-frame';   // same width for NOW and forecast
            container.appendChild(forecastImg);
            this.rain_forecast_div.appendChild(container);
        };
        forecastImg.onerror = () => {
            this.rain_forecast_div.innerHTML = '<div class="vt-empty vt-empty-big"><i class="bi bi-cloud-slash"></i><p data-i18n="rainui.forecast_unavailable">' + rainT('rainui.forecast_unavailable') + '</p></div>';
        };
    }

    openImageModal(topic) {
        // Lazily create a single full-screen modal that we reuse for both
        // the map and the forecast image.
        let modal = document.getElementById('rain-img-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rain-img-modal';
            modal.className = 'vt-lightbox';
            modal.addEventListener('click', () => { modal.style.display = 'none'; });
            document.body.appendChild(modal);
        }
        modal.innerHTML = '';
        const ts = new Date().getTime();
        const big = new Image();
        big.src = `http://${this.hostname}:8080/snapshot?topic=${topic}&t=${ts}`;
        big.className = 'vt-lightbox-img';
        modal.appendChild(big);
        modal.style.display = 'flex';
    }
    
    updateReportDiv(message) {
        if (!message) {
            console.warn("Received empty message in updateReportDiv");
            return;
        }
        this.lastMessage = message;
        
        // Format the timestamp - check if header exists
        const unavailable = rainT('rainui.unavailable');
        let formattedTimestamp = unavailable;
        if (message.time) {
            const timestamp = new Date(message.time.secs * 1000 + message.time.nsecs / 1000000);
            formattedTimestamp = timestamp.toLocaleString(window.VTI18n ? VTI18n.lang() : undefined);
        }
        
        // Generate status message - default values if properties are undefined
        const rainAlert = message.rain_alert !== undefined ? message.rain_alert : false;
        const rainNow = message.rain_now !== undefined ? message.rain_now : 0;
        
        let statusMessage = rainAlert ? 
            (rainNow > 0 ? rainT('rainui.status.raining') : rainT('rainui.status.expected')) : 
            rainT('rainui.status.none');
            
        // Safely get coordinates with fallbacks - using correct field names: lat and lon
        const latitude = message.lat !== undefined ? message.lat.toFixed(6) + "°" : unavailable;
        const longitude = message.lon !== undefined ? message.lon.toFixed(6) + "°" : unavailable;
        
        // Create the timeline visualization
        const timeline = this.createTimelineVisualization(message);
        
        // Create HTML content for report
        let reportHTML = `
            <div class="weather-report">
                <table class="table table-sm">
                    <tr>
                        <th>${rainT('rainui.th.status')}</th>
                        <td><span class="${rainAlert ? (rainNow > 0 ? 'text-danger' : 'text-warning') : 'text-success'}">${statusMessage}</span></td>
                    </tr>
                    <tr>
                        <th>${rainT('rainui.th.alert')}</th>
                        <td>${rainAlert ? rainT('common.yes') : rainT('common.no')}</td>
                    </tr>
                    <tr>
                        <th>${rainT('rainui.th.now')}</th>
                        <td>${rainNow > 0 ? rainT('common.yes') : rainT('common.no')}</td>
                    </tr>
                    <tr>
                        <th>${rainT('rainui.th.location')}</th>
                        <td>${message.location || unavailable}</td>
                    </tr>
                    <tr>
                        <th>${rainT('rainui.th.lat')}</th>
                        <td>${latitude}</td>
                    </tr>
                    <tr>
                        <th>${rainT('rainui.th.lon')}</th>
                        <td>${longitude}</td>
                    </tr>
                    <tr>
                        <th>${rainT('rainui.th.time')}</th>
                        <td>${formattedTimestamp}</td>
                    </tr>
                </table>
                
                ${timeline}
            </div>
        `;
        
        // Update the div with formatted content
        this.rain_div_report.innerHTML = reportHTML;

        // vitulus_ui R1: mirror the status line into the collapsed-summary badge.
        if (this.rain_report_status) {
            this.rain_report_status.textContent = statusMessage;
            this.rain_report_status.className =
                (rainAlert ? (rainNow > 0 ? 'text-danger' : 'text-warning') : 'text-success');
        }
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
                    <div class="timeline-label">${rainT('rainui.tl.past')}</div>
                    <div class="timeline-blocks">
                        ${this.createTimelineBlocks(pastStatuses, statusClasses, ['-60m', '-50m', '-40m', '-30m', '-20m', '-10m'])}
                    </div>
                </div>
                
                <div class="timeline-section">
                    <div class="timeline-label">${rainT('rainui.tl.now')}</div>
                    <div class="timeline-blocks">
                        <div class="timeline-block-wrapper">
                            <div class="timeline-block ${statusClasses[currentStatus]}"></div>
                            <div class="timeline-time">0m</div>
                        </div>
                    </div>
                </div>
                
                <div class="timeline-section">
                    <div class="timeline-label">${rainT('rainui.tl.forecast')}</div>
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