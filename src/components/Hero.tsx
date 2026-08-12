"use client";

import Image from "next/image";

/**
 * The stage holds the wordmark and nothing else.
 *
 * Track details live in the player at the bottom, so repeating them here would
 * only split attention between two copies of the same information.
 */
export function Hero() {
  return (
    <section
      className="stage flex items-start justify-center px-5 sm:px-6 pt-2"
      aria-label="Pattu Vandi"
    >
      <div className="anim-stage flex flex-col items-center text-center">
        {/* The drawn title logo, sized to 412×127 to match the reference. */}
        <h1 className="leading-none">
          <Image
            src="/pattu-vandi-logo.svg"
            alt="Pattu Vandi"
            width={400}
            height={130}
            className="wordmark"
            priority
            unoptimized
          />
        </h1>
      </div>
    </section>
  );
}
