/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE MANOR — Scroll-Driven Frame Animation Engine
 *  Uses GSAP ScrollTrigger + Canvas for buttery-smooth playback
 *  with lerp-based frame interpolation & cross-fade blending
 *
 *  Audio subsystem: file-based bg music + frame-synced jumpscare
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ─────────────────────────────────────────────
     CONFIGURATION
     ───────────────────────────────────────────── */
  const CONFIG = {
    totalFrames:     204,
    framePath:       'frames/ezgif-frame-',
    frameExt:        '.jpg',
    scrollDistance:   '400%',
    zoomStart:       1.0,
    zoomEnd:         1.35,
    fadeStart:       0.82,
    fadeEnd:         0.98,
    batchSize:       15,
    lerpSpeed:       0.12,
    blendFrames:     true,
  };

  /* ─────────────────────────────────────────────
     AUDIO CONFIGURATION
     ───────────────────────────────────────────── */
  const JUMPSCARE_FRAME = 157;
  const JUMPSCARE_TOLERANCE = 3;          // ±3 frames to avoid missed triggers during fast scroll
  const BG_MUSIC_PATH = 'music/backgroud.mp3';
  const JUMPSCARE_PATH = 'music/jumpscare.mp3';
  const BG_MUSIC_VOLUME = 0.35;
  const BG_MUSIC_FADE_MS = 2000;
  const JUMPSCARE_VOLUME = 0.85;

  /* ─────────────────────────────────────────────
     DOM REFS
     ───────────────────────────────────────────── */
  const canvas          = document.getElementById('frameCanvas');
  const ctx             = canvas.getContext('2d');
  const fadeOverlay      = document.getElementById('fadeOverlay');
  const preloader        = document.getElementById('preloader');
  const preloaderBar     = document.getElementById('preloaderBar');
  const preloaderPercent = document.getElementById('preloaderPercent');
  const scrollIndicator  = document.getElementById('scrollIndicator');

  /* ─────────────────────────────────────────────
     STATE
     ───────────────────────────────────────────── */
  const frames       = new Array(CONFIG.totalFrames);
  let displayFrame   = 0;
  let targetFrame    = 0;
  let lastDrawnFrame = -1;
  let lastDrawnFrac  = -1;
  let canvasW        = 0;
  let canvasH        = 0;
  let rafId          = null;
  let isAnimating    = true;

  /* ─────────────────────────────────────────────
     UTILITY
     ───────────────────────────────────────────── */
  function padNumber(n) {
    return String(n).padStart(3, '0');
  }

  function frameSrc(index) {
    return `${CONFIG.framePath}${padNumber(index + 1)}${CONFIG.frameExt}`;
  }

  /* ─────────────────────────────────────────────
     IMAGE PRELOADER
     ───────────────────────────────────────────── */
  function preloadImages() {
    return new Promise((resolve) => {
      let loaded = 0;
      let queue  = 0;

      function onLoad() {
        loaded++;
        const pct = Math.round((loaded / CONFIG.totalFrames) * 100);
        preloaderBar.style.width     = pct + '%';
        preloaderPercent.textContent = pct + '%';

        if (loaded === CONFIG.totalFrames) {
          resolve();
          return;
        }
        loadNext();
      }

      function loadNext() {
        if (queue >= CONFIG.totalFrames) return;
        const idx = queue++;
        const img = new Image();
        img.onload  = onLoad;
        img.onerror = onLoad;
        img.src = frameSrc(idx);
        frames[idx] = img;
      }

      const initialBatch = Math.min(CONFIG.batchSize, CONFIG.totalFrames);
      for (let i = 0; i < initialBatch; i++) {
        loadNext();
      }
    });
  }

  /* ─────────────────────────────────────────────
     CANVAS — sizing & drawing
     ───────────────────────────────────────────── */
  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasW = window.innerWidth;
    canvasH = window.innerHeight;
    canvas.width  = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width  = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawImageCover(img, zoom, alpha) {
    if (!img || !img.complete || !img.naturalWidth) return;

    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;

    const cx = canvasW / 2;
    const cy = canvasH / 2;
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);

    const imgRatio    = img.naturalWidth / img.naturalHeight;
    const canvasRatio = canvasW / canvasH;
    let drawW, drawH, dx, dy;

    if (canvasRatio > imgRatio) {
      drawW = canvasW;
      drawH = canvasW / imgRatio;
    } else {
      drawH = canvasH;
      drawW = canvasH * imgRatio;
    }
    dx = (canvasW - drawW) / 2;
    dy = (canvasH - drawH) / 2;

    ctx.drawImage(img, dx, dy, drawW, drawH);
    ctx.restore();
  }

  function drawFrame(floatIndex, zoom) {
    const maxIdx = CONFIG.totalFrames - 1;
    const clamped = Math.max(0, Math.min(maxIdx, floatIndex));

    const frameA = Math.floor(clamped);
    const frameB = Math.min(frameA + 1, maxIdx);
    const frac   = clamped - frameA;

    ctx.clearRect(0, 0, canvasW, canvasH);

    if (CONFIG.blendFrames && frac > 0.01 && frac < 0.99 && frameA !== frameB) {
      drawImageCover(frames[frameA], zoom, 1);
      drawImageCover(frames[frameB], zoom, frac);
    } else {
      const snapIdx = Math.round(clamped);
      drawImageCover(frames[snapIdx], zoom, 1);
    }
  }

  /* ─────────────────────────────────────────────
     RENDER LOOP
     ───────────────────────────────────────────── */
  function renderLoop() {
    if (!isAnimating) return;

    const diff = targetFrame - displayFrame;

    if (Math.abs(diff) > 0.05) {
      displayFrame += diff * CONFIG.lerpSpeed;
    } else {
      displayFrame = targetFrame;
    }

    const intFrame = Math.round(displayFrame);
    const frac = displayFrame - Math.floor(displayFrame);
    const fracChanged = Math.abs(frac - lastDrawnFrac) > 0.008;

    if (intFrame !== lastDrawnFrame || fracChanged) {
      lastDrawnFrame = intFrame;
      lastDrawnFrac  = frac;
      const progress = displayFrame / (CONFIG.totalFrames - 1);
      const zoom = CONFIG.zoomStart + (CONFIG.zoomEnd - CONFIG.zoomStart) * progress;
      drawFrame(displayFrame, zoom);
    }

    rafId = requestAnimationFrame(renderLoop);
  }

  function startRenderLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    isAnimating = true;
    renderLoop();
  }

  function stopRenderLoop() {
    isAnimating = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     CINEMATIC HORROR AUDIO ENGINE
     File-based bg music + frame-synced jumpscare with anti-overlap,
     debounce, mute toggle, and browser autoplay policy handling.
     ═══════════════════════════════════════════════════════════════════ */
  const AudioEngine = (() => {
    let bgMusic = null;
    let jumpscareAudio = null;
    let isMuted = false;
    let bgMusicStarted = false;
    let userHasInteracted = false;
    let fadeInterval = null;

    // Jumpscare trigger state
    let jumpscareArmed = true;    // can fire
    let jumpscareInZone = false;  // currently inside trigger range

    /* — Create audio elements once, reuse forever — */
    function createAudioElements() {
      bgMusic = new Audio(BG_MUSIC_PATH);
      bgMusic.loop = true;
      bgMusic.volume = 0;
      bgMusic.preload = 'auto';

      jumpscareAudio = new Audio(JUMPSCARE_PATH);
      jumpscareAudio.loop = false;
      jumpscareAudio.volume = JUMPSCARE_VOLUME;
      jumpscareAudio.preload = 'auto';
    }

    /* — Smooth volume fade for bg music — */
    function fadeVolumeTo(audio, target, durationMs) {
      if (fadeInterval) clearInterval(fadeInterval);

      const steps = 30;
      const stepTime = durationMs / steps;
      const startVol = audio.volume;
      const delta = (target - startVol) / steps;
      let step = 0;

      fadeInterval = setInterval(() => {
        step++;
        if (step >= steps) {
          audio.volume = Math.max(0, Math.min(1, target));
          clearInterval(fadeInterval);
          fadeInterval = null;
          return;
        }
        audio.volume = Math.max(0, Math.min(1, startVol + delta * step));
      }, stepTime);
    }

    /* — Background music lifecycle — */
    function startBgMusic() {
      if (bgMusicStarted || isMuted || !bgMusic) return;

      const playPromise = bgMusic.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            bgMusicStarted = true;
            fadeVolumeTo(bgMusic, BG_MUSIC_VOLUME, BG_MUSIC_FADE_MS);
          })
          .catch(() => {
            // Autoplay blocked — will retry on next interaction
            bgMusicStarted = false;
          });
      }
    }

    function stopBgMusic() {
      if (!bgMusic || !bgMusicStarted) return;
      fadeVolumeTo(bgMusic, 0, 600);
      setTimeout(() => {
        bgMusic.pause();
        bgMusicStarted = false;
      }, 650);
    }

    /* — Jumpscare playback with anti-overlap — */
    function fireJumpscare() {
      if (isMuted || !jumpscareAudio) return;

      // Hard-stop any in-progress playback to prevent stacking
      jumpscareAudio.pause();
      jumpscareAudio.currentTime = 0;
      jumpscareAudio.volume = JUMPSCARE_VOLUME;

      const playPromise = jumpscareAudio.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => { /* autoplay blocked, silent fail */ });
      }
    }

    /**
     * Called every frame from the ScrollTrigger onUpdate.
     * Determines if current frame is within the jumpscare trigger zone.
     *
     * Logic:
     *  1. Check if currentFrame is within [JUMPSCARE_FRAME - tolerance, JUMPSCARE_FRAME + tolerance]
     *  2. If entering zone AND armed → fire jumpscare, disarm
     *  3. If leaving zone → re-arm for next pass
     *
     * This handles: forward scroll, reverse scroll, fast scroll, and prevents spam.
     */
    function checkJumpscareTrigger(currentFrame) {
      const lo = JUMPSCARE_FRAME - JUMPSCARE_TOLERANCE;
      const hi = JUMPSCARE_FRAME + JUMPSCARE_TOLERANCE;
      const inZone = currentFrame >= lo && currentFrame <= hi;

      if (inZone && !jumpscareInZone) {
        // Just entered the zone
        jumpscareInZone = true;
        if (jumpscareArmed) {
          jumpscareArmed = false;
          fireJumpscare();
        }
      } else if (!inZone && jumpscareInZone) {
        // Just exited the zone — re-arm for next entry
        jumpscareInZone = false;
        jumpscareArmed = true;
      }
    }

    /* — Mute / Unmute toggle — */
    function toggleMute() {
      isMuted = !isMuted;

      if (isMuted) {
        // Mute everything
        if (bgMusic) {
          fadeVolumeTo(bgMusic, 0, 400);
          setTimeout(() => { bgMusic.pause(); }, 450);
        }
        if (jumpscareAudio) {
          jumpscareAudio.pause();
          jumpscareAudio.currentTime = 0;
        }
        bgMusicStarted = false;
      } else {
        // Unmute — restart bg music
        if (bgMusic && userHasInteracted) {
          bgMusic.volume = 0;
          const p = bgMusic.play();
          if (p !== undefined) {
            p.then(() => {
              bgMusicStarted = true;
              fadeVolumeTo(bgMusic, BG_MUSIC_VOLUME, BG_MUSIC_FADE_MS);
            }).catch(() => {});
          }
        }
      }

      return isMuted;
    }

    /* — Autoplay policy: start bg music on first user gesture — */
    function handleUserInteraction() {
      if (userHasInteracted) return;
      userHasInteracted = true;
      startBgMusic();
      // Remove listeners after first trigger — no further overhead
      document.removeEventListener('click', handleUserInteraction);
      document.removeEventListener('touchstart', handleUserInteraction);
      document.removeEventListener('scroll', handleUserInteraction);
      document.removeEventListener('keydown', handleUserInteraction);
    }

    function bindAutoplayListeners() {
      document.addEventListener('click', handleUserInteraction, { once: false, passive: true });
      document.addEventListener('touchstart', handleUserInteraction, { once: false, passive: true });
      document.addEventListener('scroll', handleUserInteraction, { once: false, passive: true });
      document.addEventListener('keydown', handleUserInteraction, { once: false, passive: true });
    }

    /* — Public init — */
    function init() {
      createAudioElements();
      bindAutoplayListeners();
    }

    return {
      init,
      checkJumpscareTrigger,
      toggleMute,
      get isMuted() { return isMuted; },
      get isPlaying() { return bgMusicStarted && !isMuted; },
    };
  })();

  /* ─────────────────────────────────────────────
     SCROLL-TRIGGER SETUP
     ───────────────────────────────────────────── */
  function initScrollAnimation() {
    gsap.registerPlugin(ScrollTrigger);

    const frameObj = { frame: 0 };

    gsap.to(frameObj, {
      frame: CONFIG.totalFrames - 1,
      ease: 'none',
      scrollTrigger: {
        trigger: '#animationSection',
        start: 'top top',
        end: 'bottom bottom',
        scrub: 0.6,
        pin: false,
        onUpdate: (self) => {
          // Set lerp target
          targetFrame = frameObj.frame;

          // ── FRAME DETECTION: current integer frame for audio triggers ──
          const currentFrame = Math.round(frameObj.frame);
          AudioEngine.checkJumpscareTrigger(currentFrame);

          // Fade-to-black overlay
          const p = self.progress;
          if (p >= CONFIG.fadeStart) {
            const fadeProgress = (p - CONFIG.fadeStart) / (CONFIG.fadeEnd - CONFIG.fadeStart);
            fadeOverlay.style.opacity = Math.min(1, fadeProgress);
          } else {
            fadeOverlay.style.opacity = 0;
          }
        },
        onLeave: () => {
          fadeOverlay.style.opacity = 1;
          displayFrame = CONFIG.totalFrames - 1;
          targetFrame  = CONFIG.totalFrames - 1;
          const zoom = CONFIG.zoomStart + (CONFIG.zoomEnd - CONFIG.zoomStart);
          drawFrame(displayFrame, zoom);
          stopRenderLoop();
        },
        onEnterBack: () => {
          fadeOverlay.style.opacity = 0;
          startRenderLoop();
        },
      },
    });

    // Hide scroll indicator on scroll
    ScrollTrigger.create({
      trigger: '#animationSection',
      start: 'top top',
      end: '+=200',
      onUpdate: (self) => {
        if (self.progress > 0.05) {
          scrollIndicator.classList.add('hidden');
        } else {
          scrollIndicator.classList.remove('hidden');
        }
      },
    });
  }

  /* ─────────────────────────────────────────────
     CONTENT REVEAL ANIMATIONS
     ───────────────────────────────────────────── */
  function initContentAnimations() {
    function reveal(selector, opts = {}) {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el, i) => {
        gsap.to(el, {
          opacity: 1,
          y: 0,
          duration: opts.duration || 0.9,
          delay: opts.stagger ? i * opts.stagger : 0,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: el,
            start: opts.start || 'top 88%',
            toggleActions: 'play none none none',
          },
        });
      });
    }

    reveal('.hero-section .section-eyebrow');
    reveal('.hero-section .hero-title', { duration: 1.1 });
    reveal('.hero-section .hero-subtitle', { duration: 1 });
    reveal('.hero-section .hero-cta', { duration: 0.8 });

    reveal('#storySection .section-eyebrow');
    reveal('#storySection .section-title');
    reveal('#storySection .section-text', { stagger: 0.15 });
    reveal('#storySection .lore-card', { duration: 1.1 });

    reveal('#gameplaySection .section-eyebrow');
    reveal('#gameplaySection .section-title');
    reveal('.feature-card', { stagger: 0.12, start: 'top 92%' });

    reveal('#statsSection .section-eyebrow');
    reveal('#statsSection .section-title');
    reveal('.stat', { stagger: 0.1, start: 'top 90%' });

    document.querySelectorAll('.stat-number').forEach((el) => {
      const target = parseInt(el.dataset.target, 10);
      const obj = { val: 0 };
      gsap.to(obj, {
        val: target,
        duration: 2,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: el,
          start: 'top 90%',
          toggleActions: 'play none none none',
        },
        onUpdate: () => {
          el.textContent = Math.round(obj.val);
        },
      });
    });

    reveal('#footerSection .section-eyebrow');
    reveal('#footerSection .section-title');
    reveal('#footerSection .section-text');
    reveal('#footerSection .btn-lg');
  }

  /* ─────────────────────────────────────────────
     AUDIO TOGGLE BUTTON
     ───────────────────────────────────────────── */
  function initAudioToggle() {
    const btn = document.getElementById('audioToggle');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const muted = AudioEngine.toggleMute();
      btn.classList.toggle('playing', !muted);
      btn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
    });

    // Show unmuted by default after preloader
    setTimeout(() => {
      btn.classList.remove('hidden');
      // Reflect initial state: bg music will auto-start, so show "playing"
      btn.classList.add('playing');
    }, 800);
  }

  /* ─────────────────────────────────────────────
     INIT
     ───────────────────────────────────────────── */
  async function init() {
    sizeCanvas();
    window.addEventListener('resize', () => {
      sizeCanvas();
      const progress = displayFrame / (CONFIG.totalFrames - 1);
      const zoom = CONFIG.zoomStart + (CONFIG.zoomEnd - CONFIG.zoomStart) * progress;
      drawFrame(displayFrame, zoom);
    });

    await preloadImages();

    drawFrame(0, CONFIG.zoomStart);

    preloader.classList.add('done');

    setTimeout(() => {
      scrollIndicator.classList.remove('hidden');
    }, 600);

    // Initialize audio engine (creates elements, binds autoplay listeners)
    AudioEngine.init();

    startRenderLoop();
    initScrollAnimation();
    initContentAnimations();
    initAudioToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
