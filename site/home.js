// The landing page's behaviour: the pillar illustrations fit their cards, and the motion. Motion is
// quiet, in Linear's manner: words rise into place, the app window settles flat as you reach it, the
// statement brightens as you read it, the Fern page comes apart into its layers, cursors drift, and
// each chapter's shot opens up. No bounce. Reduced motion gets a still page.
(() => {
  const root = document.documentElement;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // Each illustration is drawn as a 424 × 300 scene and scaled to the width of its card.
  const fit = () => $$(".art").forEach((a) => a.style.setProperty("--s", Math.min(1.2, a.clientWidth / 424).toFixed(4)));
  fit();
  addEventListener("resize", fit, { passive: true });

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { gsap, ScrollTrigger, SplitText, Lenis } = window;
  if (reduced || !gsap || !ScrollTrigger || !SplitText) {
    root.classList.remove("motion");
    return;
  }
  window.__motion = true;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  gsap.defaults({ ease: "power3.out" });

  // Smooth scrolling, with the page's own links going through it.
  if (Lenis) {
    const lenis = new Lenis({ lerp: 0.11 });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    $$('a[href^="#"]').forEach((a) =>
      a.addEventListener("click", (e) => {
        const id = a.getAttribute("href");
        const target = id === "#top" ? 0 : $(id);
        if (target === null) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -72, duration: 1.4 });
      }),
    );
  }

  /** Lines that rise out of their own masks; the split is undone afterwards so the text reflows as text. */
  const rise = (el, vars = {}) => {
    const split = SplitText.create(el, { type: "lines", mask: "lines" });
    split.lines.forEach((l) => l.parentElement.classList.add("line-mask"));
    return gsap.from(split.lines, { yPercent: 105, duration: 1.1, stagger: 0.08, ease: "power4.out", ...vars, onComplete: () => split.revert() });
  };

  /** A cursor that keeps moving a little, as a person's does. */
  const drift = (el) => {
    const step = () => gsap.to(el, { x: gsap.utils.random(-6, 6), y: gsap.utils.random(-4, 4), duration: gsap.utils.random(2.2, 3.4), ease: "sine.inOut", onComplete: step });
    step();
  };

  const start = () => {
    root.classList.remove("motion");

    // ---------------------------------------------------------- hero
    const h1 = $("h1");
    const split = SplitText.create(h1, { type: "words,lines", mask: "lines" });
    split.lines.forEach((l) => l.parentElement.classList.add("line-mask"));
    gsap
      .timeline({ delay: 0.1 })
      .from(".nav", { autoAlpha: 0, y: -8, duration: 0.7 }, 0)
      .from(split.words, { yPercent: 110, duration: 1, stagger: 0.045, ease: "power4.out", onComplete: () => split.revert() }, 0.05)
      .from(".hero-row > *", { autoAlpha: 0, y: 16, duration: 0.9, stagger: 0.1 }, 0.45)
      .from(".window", { autoAlpha: 0, y: 80, duration: 1.5, ease: "expo.out" }, 0.55);
    // The window starts tipped back and settles flat as you scroll to it.
    gsap.fromTo(".window", { rotateX: 14, transformPerspective: 1600 }, { rotateX: 0, ease: "none", scrollTrigger: { trigger: ".window", start: "top 85%", end: "top 20%", scrub: 0.6 } });

    gsap.from(".works p, .works li", { autoAlpha: 0, y: 12, duration: 0.8, stagger: 0.05, scrollTrigger: { trigger: ".works", start: "top 90%" } });

    // ---------------------------------------------------------- the statement brightens as you read it
    const big = SplitText.create(".big", { type: "words" });
    gsap.fromTo(big.words, { opacity: 0.18 }, { opacity: 1, stagger: 0.05, ease: "none", scrollTrigger: { trigger: ".big", start: "top 80%", end: "bottom 45%", scrub: true } });

    // ---------------------------------------------------------- the pillars
    gsap.from(".pillar", { autoAlpha: 0, y: 40, duration: 1.1, stagger: 0.12, ease: "expo.out", scrollTrigger: { trigger: ".pillars", start: "top 85%" } });
    const fern = $(".pillar:first-child");
    // The Fern page comes apart into its layers as it crosses the screen; their names follow.
    gsap
      .timeline({ scrollTrigger: { trigger: fern, start: "top 85%", end: "top 30%", scrub: 0.7 } })
      .fromTo($(".plane.mid", fern), { z: 0 }, { z: 46, ease: "power2.out" }, 0)
      .fromTo($(".plane.top", fern), { z: 2 }, { z: 92, ease: "power2.out" }, 0)
      .from($$(".tag", fern), { autoAlpha: 0, x: -8, stagger: 0.1, duration: 0.4 }, 0.45);
    // The agent's cursor walks in to the headline it's changing; Maya's follows.
    const agents = $(".pillar:nth-child(2)");
    gsap
      .timeline({ scrollTrigger: { trigger: agents, start: "top 80%" } })
      .from($(".cursor.claude", agents), { autoAlpha: 0, x: 90, y: -50, duration: 1.3 }, 0.2)
      .from($(".plane.target", agents), { autoAlpha: 0, duration: 0.5 }, 0.9)
      .from($(".cursor.maya", agents), { autoAlpha: 0, x: 70, y: 50, duration: 1.3 }, 0.5)
      .from($$(".drop", agents), { autoAlpha: 0, scaleY: 0, transformOrigin: "50% 0", duration: 0.6 }, 1.1)
      .add(() => $$(".cursor", agents).forEach(drift));
    // A pin drops on the page, then the thread opens: your note, and the agent's reply after it.
    const review = $(".pillar:nth-child(3)");
    gsap
      .timeline({ scrollTrigger: { trigger: review, start: "top 80%" } })
      .from($(".pin", review), { autoAlpha: 0, y: -14, duration: 0.6 }, 0.2)
      .from($(".drop", review), { autoAlpha: 0, scaleY: 0, transformOrigin: "50% 100%", duration: 0.5 }, 0.6)
      .from($(".thread", review), { autoAlpha: 0, y: 12, duration: 0.8 }, 0.8)
      .from($(".thread .reply", review), { autoAlpha: 0, y: 8, duration: 0.7 }, 1.5);

    // ---------------------------------------------------------- chapters, pricing and the ending
    $$(".ch-head").forEach((head) => {
      const tl = gsap.timeline({ scrollTrigger: { trigger: head, start: "top 82%" } });
      tl.from($(".num", head), { autoAlpha: 0, y: 10, duration: 0.7 }, 0).add(rise($("h2", head)), 0.05).from($(":scope > p", head), { autoAlpha: 0, y: 16, duration: 0.9 }, 0.25);
    });
    $$(".chapter .shot").forEach((shot, i) => {
      const img = $("img", shot);
      gsap.from(shot, { autoAlpha: 0, y: 60, duration: 1.4, ease: "expo.out", delay: shot.closest(".pair") ? (i % 2) * 0.12 : 0, scrollTrigger: { trigger: shot, start: "top 88%" } });
      if (!shot.classList.contains("crop")) gsap.fromTo(img, { scale: 1.08 }, { scale: 1, ease: "none", scrollTrigger: { trigger: shot, start: "top bottom", end: "center 40%", scrub: true } });
    });
    gsap.from(".plans", { autoAlpha: 0, y: 50, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: ".plans", start: "top 85%" } });
    gsap.timeline({ scrollTrigger: { trigger: ".end", start: "top 75%" } }).add(rise($(".end h2")), 0).from(".end .ctas > *", { autoAlpha: 0, y: 14, duration: 0.8, stagger: 0.08 }, 0.35);

    ScrollTrigger.refresh();
  };

  (document.fonts?.ready ?? Promise.resolve()).then(start);
})();
