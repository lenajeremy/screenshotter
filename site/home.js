// The landing page's two small behaviours: the nav gains a hairline once the page moves, and each
// section's cursor arrives as its section comes into view (the last ones gather on Download).
(() => {
  document.documentElement.classList.add("js");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const nav = document.querySelector(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // The hero's cursors arrive by themselves; the rest wait for their section.
  const waiting = [...document.querySelectorAll("main .cursor:not(.hero-claude):not(.hero-maya)")].filter((c) => !c.closest(".gather"));
  const gather = document.querySelector(".gather");
  if (reduced || !("IntersectionObserver" in window)) {
    gather?.classList.add("in");
    return;
  }
  waiting.forEach((c) => c.classList.add("wait"));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (e.target === gather) gather.classList.add("in");
        else e.target.classList.replace("wait", "in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.6 },
  );
  waiting.forEach((c) => io.observe(c));
  if (gather) io.observe(gather);
})();
