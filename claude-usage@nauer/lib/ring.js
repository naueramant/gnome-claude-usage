// The small progress ring shown in the top bar.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {hexToRgb} from './format.js';

export const UsageRing = GObject.registerClass(
class UsageRing extends St.DrawingArea {
    _init() {
        super._init({style_class: 'claude-usage-ring', y_align: Clutter.ActorAlign.CENTER});
        this._fraction = 0;
        this._color = '#ffffff';
        this._mode = 'normal'; // 'normal' | 'full' | 'dashed'
    }

    /**
     * @param {number} fraction 0..1
     * @param {string} color '#rrggbb'
     * @param {string} mode 'normal' | 'full' (limit reached) | 'dashed' (no data)
     */
    setState(fraction, color, mode = 'normal') {
        this._fraction = Math.max(0, Math.min(1, fraction));
        this._color = color;
        this._mode = mode;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const lw = Math.max(1.5, Math.min(w, h) * 0.14);
        const r = Math.min(w, h) / 2 - lw / 2 - 0.5;
        const cx = w / 2, cy = h / 2;
        const [red, green, blue] = hexToRgb(this._color).map(v => v / 255);

        cr.setLineWidth(lw);

        if (this._mode === 'dashed') {
            cr.setSourceRGBA(1, 1, 1, 0.55);
            cr.setDash([lw * 0.9, lw * 1.4], 0);
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            cr.stroke();
            cr.$dispose();
            return;
        }

        if (this._mode !== 'full') {
            cr.setSourceRGBA(1, 1, 1, 0.22);
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            cr.stroke();
        }

        const frac = this._mode === 'full' ? 1 : this._fraction;
        if (frac > 0) {
            cr.setSourceRGBA(red, green, blue, 1);
            cr.setLineCap(Cairo.LineCap.ROUND);
            const start = -Math.PI / 2;
            cr.arc(cx, cy, r, start, start + frac * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }
});
