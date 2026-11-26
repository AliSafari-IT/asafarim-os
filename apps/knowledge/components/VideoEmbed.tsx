"use client";
/**
 * A video in an article (#359), click-to-load: until the reader asks, nothing is fetched from the provider (no
 * request, no cookie). Then the player comes from the address lib/media/validate.ts builds from the stored provider
 * and id, in privacy mode, sandboxed.
 */
import { useState } from "react";
import { VIDEO_LABEL, videoEmbedUrl, type VideoProvider } from "@/lib/media/validate";

export function VideoEmbed({ provider, videoId, title }: { provider: VideoProvider; videoId: string; title: string }) {
  const [on, setOn] = useState(false);
  const label = VIDEO_LABEL[provider];
  return (
    <figure className="media-video" data-testid="video">
      {on ? (
        <iframe
          src={videoEmbedUrl(provider, videoId)}
          title={title}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          loading="lazy"
        />
      ) : (
        <button type="button" className="video-placeholder" onClick={() => setOn(true)} data-testid="video-load">
          <span aria-hidden="true" className="video-play">
            ▶
          </span>
          <span>
            Play “{title}”
            <small>
              Loads the {label} player: {label} will receive your IP address.
            </small>
          </span>
        </button>
      )}
      <figcaption>
        {title} <span className="muted">({label})</span>
      </figcaption>
    </figure>
  );
}
