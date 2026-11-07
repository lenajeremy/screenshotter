// The parts every page shares: the nav, copy buttons, the agent tabs and blocks fading up.
(() => {
  document.documentElement.classList.add("js");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // Nav: a hairline and glass once the page moves.
  const nav = $(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Copy buttons: the command goes to the clipboard, the icon turns to a tick.
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); }
    catch { const pre = b.parentElement.querySelector("pre"); if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1600);
  }));

  // Agent tabs, with arrow keys.
  // A command too wide for its box fades out at the edge (it still scrolls).
  const fit = () => $$(".install pre").forEach((p) => p.classList.toggle("over", p.scrollWidth > p.clientWidth + 1));
  addEventListener("resize", fit, { passive: true });
  const tabs = $$(".tabs [role=tab]");
  const pick = (t) => { tabs.forEach((x) => { const on = x === t; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; $("#" + x.getAttribute("aria-controls")).hidden = !on; }); fit(); };
  fit();
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      pick(n); n.focus();
    });
  });

  // Reveal each block once as it arrives; blocks arriving together are staggered.
  const rv = $$(".rv");
  if (reduced || !("IntersectionObserver" in window)) rv.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e, i) => { e.target.style.setProperty("--d", i * 60 + "ms"); e.target.classList.add("in"); io.unobserve(e.target); });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
    rv.forEach((el) => io.observe(el));
  }
})();
