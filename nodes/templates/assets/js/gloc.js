// Gloc — "Loc" tab: lidar global localization (gloc_server) assessment panel.
// Shows where the current /scan COULD be in the loaded map (best hypothesis,
// ambiguity margin, top candidates, score heatmap) and lets the user apply
// the hypothesis to the robot (rtabmap initialpose) — gated by the margin
// on the server side; Force bypasses the gate.
class Gloc {
    constructor(ros) {
        this.ros = ros;

        this.btn_localize = document.getElementById("gloc_btn_localize");
        this.chk_auto = document.getElementById("gloc_chk_auto");
        this.btn_apply = document.getElementById("gloc_btn_apply");
        this.btn_force = document.getElementById("gloc_btn_force");
        this.el_status = document.getElementById("gloc_status");
        this.el_best = document.getElementById("gloc_best");
        this.el_margin = document.getElementById("gloc_margin");
        this.el_current = document.getElementById("gloc_current");
        this.el_delta = document.getElementById("gloc_delta");
        this.el_meta = document.getElementById("gloc_meta");
        this.el_top = document.getElementById("gloc_top_tbody");
        this.el_img = document.getElementById("gloc_heatmap_img");

        this.autoTimer = null;
        this.lastResult = null;

        this.compute_publisher = new ROSLIB.Topic({
            ros: ros, name: '/gloc/compute', messageType: 'std_msgs/String'
        });
        this.compute_publisher.advertise();
        this.apply_publisher = new ROSLIB.Topic({
            ros: ros, name: '/gloc/apply', messageType: 'std_msgs/String'
        });
        this.apply_publisher.advertise();

        this.result_subscriber = new ROSLIB.Topic({
            ros: ros, name: '/gloc/result', messageType: 'std_msgs/String'
        });
        this.result_subscriber.subscribe(this.handleResult.bind(this));

        this.status_subscriber = new ROSLIB.Topic({
            ros: ros, name: '/gloc/status', messageType: 'std_msgs/String'
        });
        this.status_subscriber.subscribe((m) => {
            this.el_status.textContent = m.data;
            this.el_status.style.color =
                m.data.startsWith('error') || m.data.startsWith('apply refused') ? '#ff6b6b' :
                m.data.startsWith('APPLIED') ? '#ffd43b' : '';
        });

        // rosbridge delivers CompressedImage.data as base64 already
        this.heatmap_subscriber = new ROSLIB.Topic({
            ros: ros, name: '/gloc/heatmap', messageType: 'sensor_msgs/CompressedImage'
        });
        this.heatmap_subscriber.subscribe((m) => {
            this.el_img.src = 'data:image/' + (m.format || 'png') + ';base64,' + m.data;
            this.el_img.style.display = 'block';
        });

        this.btn_localize.addEventListener('click', () => this.localize());
        this.btn_apply.addEventListener('click', () => this.apply(''));
        this.btn_force.addEventListener('click', () => this.apply('force'));
        this.chk_auto.addEventListener('change', () => {
            if (this.chk_auto.checked) {
                this.localize();
                this.autoTimer = setInterval(() => this.localize(), 5000);
            } else if (this.autoTimer) {
                clearInterval(this.autoTimer);
                this.autoTimer = null;
            }
        });
    }

    localize() {
        this.el_status.textContent = 'computing...';
        this.compute_publisher.publish(new ROSLIB.Message({data: ''}));
    }

    apply(mode) {
        this.apply_publisher.publish(new ROSLIB.Message({data: mode}));
    }

    fmtPose(p) {
        return '(' + p.x.toFixed(2) + ', ' + p.y.toFixed(2) + ') ' +
               p.yaw_deg.toFixed(1) + '°';
    }

    handleResult(msg) {
        let r;
        try { r = JSON.parse(msg.data); } catch (e) { return; }
        this.lastResult = r;

        this.el_best.textContent = this.fmtPose(r.best) +
            '  score ' + r.best.score_m.toFixed(3) + ' m';
        const mtxt = (r.margin >= 9) ? '>900%' : Math.round(r.margin * 100) + '%';
        this.el_margin.textContent = mtxt + (r.margin_ok ?
            '  ✓ unambiguous' : '  ⚠ AMBIGUOUS (gate ' +
            Math.round(r.apply_min_margin * 100) + '%)');
        this.el_margin.style.color = r.margin_ok ? '#51cf66' : '#ff6b6b';
        this.el_current.textContent = r.current_pose ?
            this.fmtPose(r.current_pose) : 'no map→base tf';
        this.el_delta.textContent = r.delta_to_current ?
            (r.delta_to_current.dist_m.toFixed(2) + ' m / ' +
             r.delta_to_current.dyaw_deg.toFixed(1) + '°') : '—';
        this.el_meta.textContent = r.compute_s.toFixed(2) + ' s, ' +
            r.hypotheses.toLocaleString() + ' hypotheses, ' + r.rays_used + ' rays';

        this.el_top.innerHTML = '';
        (r.top || []).forEach((t, i) => {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td style="opacity:.6;">' + (i + 1) + '.</td><td>' +
                this.fmtPose(t) + '</td><td style="opacity:.8;">' +
                t.score.toFixed(4) + '</td>';
            this.el_top.appendChild(tr);
        });

        this.btn_apply.disabled = !r.margin_ok;
        this.btn_force.disabled = false;
    }
}
