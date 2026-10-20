// The 9:16 preview under "Tampilan klip" (lib/look-preview.mjs). One SVG in output pixels, so
// every spot scales with the frame. The subtitle is its pack's FFmpeg thumbnail placed where the
// thumbnail was cut from the frame, on the backdrop it was rendered on, so it shows no edge. The
// note on where the subtitle sits is the page's, under the subtitle styles.
import { PACK_IMAGES, imageSrc } from "../../components/editor/panels/pack-images.js";
import { PREVIEW_BACKDROP, PREVIEW_PICTURE } from "../../lib/editor/content-colours.mjs";
import styles from "./look.module.css";

export default function LookPreview({ look }) {
  const { frame, picture, caption, hook, zone } = look;
  const { w, h } = frame;
  const middle = h - zone.top - zone.bottom;
  return (
    <figure className={styles.preview}>
      <div className={styles.frame}>
        <svg
          className={styles.canvas}
          viewBox={`0 0 ${look.frame.w} ${look.frame.h}`}
          role="img"
          aria-label={look.label}
          focusable="false"
          data-look-preview=""
          data-layout={picture.mode}
          data-pack={caption.pack}
          data-hook={hook ? "on" : "off"}
        >
          <rect width={w} height={h} fill={PREVIEW_BACKDROP} />
          {picture.band && <rect key="band" className={styles.appear} x={picture.band.x} y={picture.band.y} width={picture.band.w} height={picture.band.h} fill={PREVIEW_PICTURE} />}
          {hook && (
            <g key="hook" className={styles.appear}>
              <rect className={styles.hookBox} x={hook.box.x} y={hook.box.y} width={hook.box.w} height={hook.box.h} />
              <text className={styles.hookText} x={w / 2} y={hook.box.y + hook.box.h / 2} fontSize={hook.fontSize} textAnchor="middle" dominantBaseline="central">{hook.text}</text>
            </g>
          )}
          <image
            key={caption.pack}
            className={styles.appear}
            href={imageSrc(PACK_IMAGES[caption.pack])}
            x={caption.image.x}
            y={caption.image.y}
            width={caption.image.w}
            height={caption.image.h}
            preserveAspectRatio="none"
          />
          <rect className={styles.veil} x="0" y="0" width={w} height={zone.top} />
          <rect className={styles.veil} x="0" y={h - zone.bottom} width={w} height={zone.bottom} />
          <rect className={styles.veil} x={w - zone.right} y={zone.top} width={zone.right} height={middle} />
          <rect className={styles.edge} x="4" y={zone.top} width={w - zone.right - 4} height={middle} />
        </svg>
      </div>
      <figcaption className={styles.key}><i aria-hidden="true" />Area tombol TikTok</figcaption>
    </figure>
  );
}
