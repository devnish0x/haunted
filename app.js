/**
 * ═══════════════════════════════════════════════════════════════════
 *  THE MANOR — Scroll-Driven Frame Animation Engine
 *  Uses GSAP ScrollTrigger + Canvas for buttery-smooth playback
 *  with lerp-based frame interpolation & cross-fade blending
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
    scrollDistance:   '400%',   // how far the user scrolls for full animation
    zoomStart:       1.0,      // canvas scale at frame 0
    zoomEnd:         1.35,     // canvas scale at final frame
    fadeStart:       0.82,     // scroll progress where fade-to-black begins
    fadeEnd:         0.98,     // scroll progress where fade is fully black
    batchSize:       15,       // how many images to load in parallel per batch
    lerpSpeed:       0.12,     // smoothing factor (0 = frozen, 1 = instant snap)
    blendFrames:     true,     // cross-fade blend between adjacent frames
  };

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
  const frames       = new Array(CONFIG.totalFrames);  // Image objects
  let displayFrame   = 0;       // smoothed float frame (lerp'd towards target)
  let targetFrame    = 0;       // exact frame requested by ScrollTrigger
  let lastDrawnFrame = -1;      // last integer frame actually drawn
  let lastDrawnFrac  = -1;      // last fractional part drawn (for blend detection)
  let canvasW        = 0;
  let canvasH        = 0;
  let rafId          = null;
  let isAnimating    = true;

  /* ─────────────────────────────────────────────
     UTILITY — pad frame number to 3 digits
     ───────────────────────────────────────────── */
  function padNumber(n) {
    return String(n).padStart(3, '0');
  }

  function frameSrc(index) {
    return `${CONFIG.framePath}${padNumber(index + 1)}${CONFIG.frameExt}`;
  }

  /* ─────────────────────────────────────────────
     IMAGE PRELOADER
     Loads in batches to avoid hammering the
     browser with 200+ parallel requests.
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

  /**
   * Draw a single image to canvas with cover-fit + zoom.
   */
  function drawImageCover(img, zoom, alpha) {
    if (!img || !img.complete || !img.naturalWidth) return;

    ctx.save();

    if (alpha < 1) ctx.globalAlpha = alpha;

    // Apply zoom from center
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);

    // Cover-fit calculation
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

  /**
   * Draw frame with optional cross-fade blending between
   * two adjacent frames for sub-frame smoothness.
   */
  function drawFrame(floatIndex, zoom) {
    const maxIdx = CONFIG.totalFrames - 1;
    const clamped = Math.max(0, Math.min(maxIdx, floatIndex));

    const frameA = Math.floor(clamped);
    const frameB = Math.min(frameA + 1, maxIdx);
    const frac   = clamped - frameA;

    ctx.clearRect(0, 0, canvasW, canvasH);

    if (CONFIG.blendFrames && frac > 0.01 && frac < 0.99 && frameA !== frameB) {
      // Cross-fade: draw base frame fully, overlay next frame with fractional alpha
      drawImageCover(frames[frameA], zoom, 1);
      drawImageCover(frames[frameB], zoom, frac);
    } else {
      // Single frame (no blend needed — we're close enough to an integer frame)
      const snapIdx = Math.round(clamped);
      drawImageCover(frames[snapIdx], zoom, 1);
    }
  }

  /* ─────────────────────────────────────────────
     RENDER LOOP — requestAnimationFrame
     Uses lerp smoothing so the displayed frame
     glides towards the target instead of jumping.
     ───────────────────────────────────────────── */
  function renderLoop() {
    if (!isAnimating) return;

    // Lerp towards target
    const diff = targetFrame - displayFrame;

    if (Math.abs(diff) > 0.05) {
      // Smooth interpolation
      displayFrame += diff * CONFIG.lerpSpeed;
    } else {
      // Snap when close enough to avoid infinite drift
      displayFrame = targetFrame;
    }

    // Only redraw if something visually changed
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
        scrub: 0.6,          // higher scrub = smoother but laggier
        pin: false,
        onUpdate: (self) => {
          // Set the target — renderLoop lerps towards it
          targetFrame = frameObj.frame;

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
          // Let the render loop finish smoothing to final frame
          displayFrame = CONFIG.totalFrames - 1;
          targetFrame  = CONFIG.totalFrames - 1;
          const progress = 1;
          const zoom = CONFIG.zoomStart + (CONFIG.zoomEnd - CONFIG.zoomStart) * progress;
          drawFrame(displayFrame, zoom);
          stopRenderLoop();
        },
        onEnterBack: () => {
          fadeOverlay.style.opacity = 0;
          startRenderLoop();
        },
      },
    });

    // Hide scroll indicator once user starts scrolling
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
    // Generic reveal helper
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

    // Hero section
    reveal('.hero-section .section-eyebrow');
    reveal('.hero-section .hero-title', { duration: 1.1 });
    reveal('.hero-section .hero-subtitle', { duration: 1 });
    reveal('.hero-section .hero-cta', { duration: 0.8 });

    // Story section
    reveal('#storySection .section-eyebrow');
    reveal('#storySection .section-title');
    reveal('#storySection .section-text', { stagger: 0.15 });
    reveal('#storySection .lore-card', { duration: 1.1 });

    // Gameplay features
    reveal('#gameplaySection .section-eyebrow');
    reveal('#gameplaySection .section-title');
    reveal('.feature-card', { stagger: 0.12, start: 'top 92%' });

    // Stats
    reveal('#statsSection .section-eyebrow');
    reveal('#statsSection .section-title');
    reveal('.stat', { stagger: 0.1, start: 'top 90%' });

    // Animate stat numbers counting up
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

    // Footer
    reveal('#footerSection .section-eyebrow');
    reveal('#footerSection .section-title');
    reveal('#footerSection .section-text');
    reveal('#footerSection .btn-lg');
  }

  /* ─────────────────────────────────────────────
     AMBIENT AUDIO ENGINE (Web Audio API)
     Procedurally generates a dark, atmospheric
     drone soundscape — no external file needed.
     ───────────────────────────────────────────── */
  const AmbientAudio = (() => {
    let audioCtx    = null;
    let masterGain  = null;
    let isPlaying   = false;
    let nodes       = [];

    const VOLUME = 0.18;          // master volume (0–1)
    const FADE_TIME = 1.5;        // fade in/out duration in seconds

    function createContext() {
      audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0;
      masterGain.connect(audioCtx.destination);
    }

    /**
     * Build layered drones: fundamental + detuned harmonics
     * through a low-pass filter for that muffled, eerie feel.
     */
    function createDrone(freq, detune, filterFreq, gainVal) {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = filterFreq;
      filter.Q.value = 1.5;

      const gain = audioCtx.createGain();
      gain.gain.value = gainVal;

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);
      osc.start();

      nodes.push({ osc, filter, gain });
      return { osc, filter, gain };
    }

    /**
     * Filtered noise layer for atmospheric texture
     */
    function createNoise(filterFreq, gainVal) {
      const bufferSize = audioCtx.sampleRate * 4;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.5;
      }

      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = filterFreq;
      filter.Q.value = 0.7;

      const gain = audioCtx.createGain();
      gain.gain.value = gainVal;

      source.connect(filter);
      filter.connect(gain);
      gain.connect(masterGain);
      source.start();

      nodes.push({ osc: source, filter, gain });
    }

    /**
     * Slow LFO modulating a drone's filter for organic movement
     */
    function createLFO(targetParam, rate, depth, center) {
      const lfo = audioCtx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = rate;

      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = depth;

      lfo.connect(lfoGain);
      lfoGain.connect(targetParam);
      targetParam.value = center;
      lfo.start();

      nodes.push({ osc: lfo, gain: lfoGain });
    }

    function buildSoundscape() {
      // Deep sub-bass drone
      const d1 = createDrone(55, 0, 200, 0.35);

      // Slightly detuned octave for unease
      createDrone(110.5, -8, 400, 0.15);

      // High eerie harmonic
      createDrone(330, 12, 600, 0.06);

      // Fifth interval for that hollow feel
      createDrone(82.5, -5, 300, 0.12);

      // Filtered noise — wind/static texture
      createNoise(250, 0.04);

      // LFO on the main drone's filter for slow breathing movement
      createLFO(d1.filter.frequency, 0.08, 80, 200);
    }

    function start() {
      if (isPlaying) return;

      if (!audioCtx) {
        createContext();
        buildSoundscape();
      }

      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      // Fade in
      masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      masterGain.gain.setValueAtTime(masterGain.gain.value, audioCtx.currentTime);
      masterGain.gain.linearRampToValueAtTime(VOLUME, audioCtx.currentTime + FADE_TIME);

      isPlaying = true;
    }

    function stop() {
      if (!isPlaying || !audioCtx) return;

      // Fade out
      masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      masterGain.gain.setValueAtTime(masterGain.gain.value, audioCtx.currentTime);
      masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + FADE_TIME);

      isPlaying = false;
    }

    function toggle() {
      if (isPlaying) { stop(); } else { start(); }
      return isPlaying;
    }

    return { start, stop, toggle, get isPlaying() { return isPlaying; } };
  })();

  /* ─────────────────────────────────────────────
     AUDIO TOGGLE BUTTON
     ───────────────────────────────────────────── */
  function initAudioToggle() {
    const btn = document.getElementById('audioToggle');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const playing = AmbientAudio.toggle();
      btn.classList.toggle('playing', playing);
    });

    // Show the button after preloader is done
    setTimeout(() => {
      btn.classList.remove('hidden');
    }, 800);
  }

  /* ─────────────────────────────────────────────
     INIT
     ───────────────────────────────────────────── */
  async function init() {
    sizeCanvas();
    window.addEventListener('resize', () => {
      sizeCanvas();
      // Redraw current frame on resize
      const progress = displayFrame / (CONFIG.totalFrames - 1);
      const zoom = CONFIG.zoomStart + (CONFIG.zoomEnd - CONFIG.zoomStart) * progress;
      drawFrame(displayFrame, zoom);
    });

    // Preload all frames
    await preloadImages();

    // Draw first frame immediately
    drawFrame(0, CONFIG.zoomStart);

    // Hide preloader
    preloader.classList.add('done');

    // Show scroll indicator after a beat
    setTimeout(() => {
      scrollIndicator.classList.remove('hidden');
    }, 600);

    // Start render loop & scroll animation
    startRenderLoop();
    initScrollAnimation();
    initContentAnimations();
    initAudioToggle();
  }

  // Kick off
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
