"use client";

// The landing's Sesudah clip. lib/landing-preview.mjs decides when it plays: only on screen,
// never in a hidden tab, paused from the start under prefers-reduced-motion. The button exists
// only once that logic runs, so a page without JavaScript shows the poster and no dead control.
import { useEffect, useRef, useState } from "react";

import { LANDING_MEDIA } from "../lib/landing-media.mjs";
import { attachPreview, previewButtonLabel } from "../lib/landing-preview.mjs";

export default function LandingClip({ className, frameClassName, barClassName, buttonClassName, children }) {
  const videoRef = useRef(null);
  const previewRef = useRef(null);
  const [state, setState] = useState(null);
  const clip = LANDING_MEDIA.sesudah;

  useEffect(() => {
    const preview = attachPreview(videoRef.current, { onChange: setState });
    previewRef.current = preview;
    return () => {
      preview.destroy();
      previewRef.current = null;
    };
  }, []);

  return (
    <figure className={className}>
      <div className={frameClassName}>
        <video
          ref={videoRef}
          src={clip.src}
          poster={clip.poster}
          width={clip.width}
          height={clip.height}
          muted
          loop
          playsInline
          preload="none"
          disablePictureInPicture
          aria-label="Klip 9:16 hasil Potongin dari adegan yang sama, tanpa suara"
        />
      </div>
      <figcaption className={barClassName}>
        {children}
        {state && (
          <button type="button" className={buttonClassName} onClick={() => previewRef.current?.toggle()}>
            {previewButtonLabel(state)}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
