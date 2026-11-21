// What Screenshotter does, shown on Home before anything is made: a small board where an agent
// rewrites a site's headline, recolours it, then builds the phone version beside it. CSS only, on
// one 12-second loop; with reduced motion it rests on the finished board.
import { html } from "./controls.js";

export function HomeDemo() {
  return html`<div class="demo" aria-hidden="true">
    <div class="demo-stage">
      <span class="demo-pill"><i></i>Claude is working on Loaf</span>

      <span class="demo-label" style=${{ left: "28px", top: "62px" }}>Loaf — desktop</span>
      <div class="demo-ab desk">
        <div class="dm-nav"><i class="dm-logo"></i><b>Loaf</b><span class="grow"></span><i class="dm-bar"></i><i class="dm-bar"></i><i class="dm-bar"></i><span class="dm-order">Order</span></div>
        <div class="dm-hero">
          <i class="dm-eyebrow"></i>
          <div class="dm-head"><span class="dm-a">Baked fresh every morning.</span><span class="dm-b">Worth waking up for.</span></div>
          <i class="dm-line"></i><i class="dm-line short"></i>
          <span class="dm-btn">See today’s loaves</span>
          <div class="dm-loaves"><i></i><i></i><i></i></div>
        </div>
        <span class="demo-sel head"><i></i><i></i><i></i><i></i></span>
        <span class="demo-sel sbtn"><i></i><i></i><i></i><i></i></span>
      </div>

      <span class="demo-label late" style=${{ left: "362px", top: "62px" }}>Loaf — phone</span>
      <div class="demo-ab phone late">
        <div class="pb" style="--i:0"><i class="dm-logo"></i><b>Loaf</b></div>
        <div class="pb hero" style="--i:1">
          <span class="pb-head">Worth waking up for.</span>
          <i class="dm-line"></i><i class="dm-line short"></i>
          <span class="dm-btn">Today’s loaves</span>
        </div>
        <div class="pb tile" style="--i:2"></div>
        <div class="pb tile" style="--i:3"></div>
      </div>

      <span class="demo-cursor">
        <svg width="18" height="18" viewBox="0 0 18 18"><path d="M2.5 1.8 15 7.6l-5.6 1.7-2.4 5.6z" fill="#b9583a" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" /></svg>
        <b>Claude</b>
      </span>
    </div>
  </div>`;
}
