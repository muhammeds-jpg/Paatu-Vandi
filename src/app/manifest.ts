import type { MetadataRoute } from "next";
import { SITE } from "@/config/tracks";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.description,
    start_url: "/",
    display: "standalone",
    background_color: "#08080a",
    theme_color: "#08080a",
    /**
     * Separate files per purpose, not the same PNG listed twice.
     *
     * Android clips a maskable icon to a circle or squircle and keeps only the
     * central ~80%, so the logo has to sit inside that safe zone or its ends get
     * sliced off. The "any" variant is shown whole and lets the logo run wider.
     * `npm run gen:icons` builds both from the backdrop artwork.
     *
     * Listed as separate entries per purpose rather than the spec's
     * space-separated "any maskable": Next's Manifest type models purpose as a
     * single value, so the combined string is a type error.
     */
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
