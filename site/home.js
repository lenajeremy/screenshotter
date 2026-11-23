// The landing page's motion. Everyone on a Glassine board has a cursor, people and agents alike, so
// the motion follows them: Claude Code writes the headline, each section's cursor glides in and
// keeps drifting the way a person's does, Maya moves from Free to Team, and at the end every cursor
// gathers on Download. Around them: headings that rise line by line, product shots that tilt up and
// drift past at their own pace, and smooth scrolling. Nothing bounces. Reduced motion gets none of it.
(() => {
  const root = document.documentElement;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const nav = $(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { gsap, ScrollTrigger, SplitText, Lenis } = window;
  if (reduced || !gsap || !ScrollTrigger || !SplitText) {
    root.classList.remove("motion");
    return;
  }
  window.__motion = true;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  gsap.defaults({ ease: "power3.out" });

  // Smooth scrolling, with in-page links going through it.
  let lenis = null;
  if (Lenis) {
    lenis = new Lenis({ lerp: 0.11 });
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

  /** A cursor's own wander once it has arrived: its arrow and name drift together, slowly. */
  const wander = (cursor) => {
    const parts = [...cursor.children];
    const step = () =>
      gsap.to(parts, { x: gsap.utils.random(-7, 7), y: gsap.utils.random(-5, 5), duration: gsap.utils.random(2.2, 3.4), ease: "sine.inOut", onComplete: step });
    step();
  };

  /** Lines that rise out of their own masks. The split is undone afterwards, so the text reflows as text. */
  const rise = (el, vars = {}) => {
    const split = SplitText.create(el, { type: "lines", mask: "lines", linesClass: "line" });
    $$(".line", el).forEach((l) => l.parentElement.classList.add("line-mask"));
    return gsap.from(split.lines, { yPercent: 108, duration: 1.1, stagger: 0.09, ease: "power4.out", ...vars, onComplete: () => split.revert() });
  };

  const start = () => {
    root.classList.remove("motion");
    hero();
    sections();
    ending();
    ScrollTrigger.refresh();
  };

  // ---------------------------------------------------------------- the hero
  function hero() {
    const copy = $(".hero-copy");
    const h1 = $("h1", copy);
    const claude = $(".hero-claude");
    const maya = $(".hero-maya");

    // Claude Code's cursor leaves the headline's markup (it only sits there for pages without
    // the script) and is placed by where the words fall.
    copy.append(claude);
    claude.style.right = claude.style.bottom = "auto";
    const rest = () => {
      const c = copy.getBoundingClientRect();
      // Looked up each time: undoing the split puts new nodes in the headline.
      const m = $(".mark", h1).getBoundingClientRect();
      // On a narrow screen "agents," sits mid-line, so the cursor rests just above the headline's top right instead.
      const narrow = innerWidth <= 980;
      const h = h1.getBoundingClientRect();
      claude.style.left = `${(narrow ? Math.min(h.right, c.right - 110) - 40 : m.right + 2) - c.left}px`;
      claude.style.top = `${(narrow ? h.top - 34 : m.top + m.height * 0.5) - c.top}px`;
    };

    const split = SplitText.create(h1, { type: "words,lines", mask: "lines", linesClass: "line" });
    $$(".line", h1).forEach((l) => l.parentElement.classList.add("line-mask"));
    rest();
    const first = split.words[0].getBoundingClientRect();
    const end = claude.getBoundingClientRect();

    const tl = gsap.timeline({ delay: 0.15 });
    tl.from(nav, { autoAlpha: 0, y: -10, duration: 0.7 }, 0)
      .from(split.words, { yPercent: 110, duration: 1, stagger: 0.055, ease: "power4.out" }, 0.1)
      // The agent's cursor runs along the first line as its words appear, and stops after "agents,".
      .fromTo(claude, { autoAlpha: 0, x: first.left - end.left, y: 8 }, { autoAlpha: 1, x: 0, y: 0, duration: 0.25 + split.words.length * 0.055 * 0.6, ease: "power2.inOut" }, 0.15)
      .from(".hero .sub", { autoAlpha: 0, y: 18, duration: 0.9 }, 0.55)
      .from($$(".ctas > .btn"), { autoAlpha: 0, y: 14, duration: 0.8, stagger: 0.08 }, 0.7)
      .from(".hero .fine", { autoAlpha: 0, duration: 0.8 }, 0.9)
      .fromTo(maya, { autoAlpha: 0, x: 90, y: 60 }, { autoAlpha: 1, x: 0, y: 0, duration: 1.3 }, 1.0)
      .from(".hero-shot", { autoAlpha: 0, y: 90, duration: 1.5, ease: "expo.out" }, 0.55)
      .add(() => {
        split.revert();
        // The words are back as plain text; the cursor stays where "agents," ends, as the window changes.
        addEventListener("resize", rest, { passive: true });
        rest();
        wander(claude);
        if (getComputedStyle(maya).display !== "none") wander(maya);
      });

    // As you scroll on, the editor shot tilts up from the table to face you.
    gsap.fromTo(".hero-shot", { rotateX: 16, scale: 0.94 }, { rotateX: 0, scale: 1, ease: "none", scrollTrigger: { trigger: ".hero-shot", start: "top 92%", end: "top 18%", scrub: 0.6 } });
  }

  // ---------------------------------------------------------------- the sections
  function sections() {
    // The agents' logos, one after another.
    gsap.from(".agents p, .agents li", { autoAlpha: 0, y: 14, duration: 0.8, stagger: 0.06, scrollTrigger: { trigger: ".agents", start: "top 82%" } });

    // Each heading rises line by line; its words follow; its cursor glides in and stays alive.
    $$(".feature, .team, .code, .pricing").forEach((section) => {
      const h2 = $("h2", section);
      const cursor = $(":scope > .cursor, :scope > .words > .cursor, :scope > .code-head .cursor", section);
      const words = $$(":scope > p, :scope > .words > p, :scope > .code-head > p", section);
      const tl = gsap.timeline({ scrollTrigger: { trigger: h2, start: "top 84%" } });
      tl.add(rise(h2), 0).from(words, { autoAlpha: 0, y: 18, duration: 0.9 }, 0.2);
      if (cursor) {
        tl.fromTo(cursor, { autoAlpha: 0, x: 70, y: -46 }, { autoAlpha: 1, x: 0, y: 0, duration: 1.2 }, 0.1);
        tl.add(() => wander(cursor));
      }
    });

    // Product shots open from a slightly smaller frame, then drift past at their own pace.
    $$(".feature .shot, .team .shot").forEach((shot) => {
      const img = $("img", shot);
      gsap.from(shot, { clipPath: "inset(7% 6% 7% 6% round 12px)", y: 60, duration: 1.4, ease: "expo.out", scrollTrigger: { trigger: shot, start: "top 88%" } });
      gsap.set(img, { scale: 1.1 });
      gsap.fromTo(img, { yPercent: -4 }, { yPercent: 4, ease: "none", scrollTrigger: { trigger: shot, start: "top bottom", end: "bottom top", scrub: true } });
    });
    $$(".pair .shot").forEach((shot, i) => {
      gsap.from(shot, { autoAlpha: 0, y: 70, duration: 1.3, delay: i * 0.12, ease: "expo.out", scrollTrigger: { trigger: ".pair", start: "top 86%" } });
      gsap.fromTo($("img", shot), { y: i ? 40 : 16 }, { y: i ? -40 : -16, ease: "none", scrollTrigger: { trigger: ".pair", start: "top bottom", end: "bottom top", scrub: true } });
    });

    // Pricing: the plans come up together, then Maya moves from the Free plan to Start a team.
    const plans = $$(".plan");
    const maya = $(".team-plan > .cursor");
    const from = $(".plan:not(.team-plan) .btn");
    const tl = gsap.timeline({ scrollTrigger: { trigger: ".plans", start: "top 80%" } });
    tl.from(plans, { autoAlpha: 0, y: 50, duration: 1.1, stagger: 0.12, ease: "expo.out" });
    if (maya && from) {
      tl.fromTo(
        maya,
        { autoAlpha: 0, x: () => from.getBoundingClientRect().left + 60 - maya.getBoundingClientRect().left, y: () => from.getBoundingClientRect().top - maya.getBoundingClientRect().top },
        { autoAlpha: 1, x: 0, y: 0, duration: 1.6, ease: "power2.inOut" },
        0.5,
      ).add(() => wander(maya));
    }
  }

  // ---------------------------------------------------------------- the ending
  function ending() {
    const far = { g1: [240, -180], g2: [-300, -60], g3: [280, 140], g4: [-220, -200] };
    const cursors = $$(".gather .cursor").filter((c) => getComputedStyle(c).display !== "none");
    const tl = gsap.timeline({ scrollTrigger: { trigger: ".end", start: "top 70%" } });
    tl.add(rise($(".end h2")), 0)
      .from(".end .btn", { autoAlpha: 0, y: 20, duration: 0.9 }, 0.35)
      .from(".end .fine", { autoAlpha: 0, duration: 0.8 }, 0.5);
    cursors.forEach((c, i) => {
      const [x, y] = far[[...c.classList].find((k) => far[k])] ?? [0, 200];
      tl.fromTo(c, { autoAlpha: 0, x, y }, { autoAlpha: 1, x: 0, y: 0, duration: 1.6, ease: "power3.out" }, 0.5 + i * 0.12);
    });
    tl.add(() => cursors.forEach(wander));
  }

  (document.fonts?.ready ?? Promise.resolve()).then(start);
})();
