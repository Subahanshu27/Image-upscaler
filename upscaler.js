/* Free AI Image Upscaler — Floyo design system
   Vanilla JS state machine. No build step.

   Real uploads are sent to the Flask backend (SeedVR2 + TTP workflow on Floyo).
   "Try a sample" / "add a URL" stay as an offline demo so the page is
   explorable without spending GPU credits.
*/
(function () {
  "use strict";


  // ── Backend config ─────────────────────────────────────────────────
  // Local testing auto-points at the Flask server on port 5000.
  // Before deploying, set the production URL below (your HTTPS backend).
  var API_BASE =
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
      ? "http://localhost:5000"
      : "https://api.aiupscaleronline.com";   // production backend (EC2 behind nginx + Let's Encrypt)

  // ── State ──────────────────────────────────────────────────────────
  var S = {
    variant: "A",                 // A | B | C  (empty-screen layout)
    phase: "empty",               // empty | selected | processing | result | error
    factor: 4,                    // 2 | 4 | 8
    detail: 3,                    // 0..3  Soft|Normal|Sharp|Very sharp
    color: true,                  // color correction
    format: "jpg",                // jpg | png | webp
    apiKey: "",                   // user's Floyo API key (BYOK)
    img: null                     // {name,w,h,after,before,original,file,resultUrl,resultName}
  };

  var DETAIL_LABELS = ["Soft", "Normal", "Sharp", "Very sharp"];
  var DETAIL_KEYS = ["soft", "normal", "sharp", "very_sharp"]; // -> backend "sharpness"
  var MAX_MB = 25;
  var MAX_PIXELS = 6000000;       // mirror backend MAX_INPUT_PIXELS (~6 MP)

  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  // ── Output math ────────────────────────────────────────────────────
  function outDims() {
    if (!S.img) return null;
    return { w: Math.round(S.img.w * S.factor), h: Math.round(S.img.h * S.factor) };
  }
  function tierLabel() {
    var d = outDims(); if (!d) return "";
    var L = Math.max(d.w, d.h);
    if (L >= 6000) return "8K";
    if (L >= 3000) return "4K";
    if (L >= 1500) return "2K";
    return "HD";
  }

  // ── Sample image (canvas-drawn "photo" with real detail) ────────────
  function makeSample(cb) {
    var W = 2048, H = 1280;
    var c = document.createElement("canvas"); c.width = W; c.height = H;
    var x = c.getContext("2d");
    var g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#7AC0FF"); g.addColorStop(0.55, "#D5B8FF"); g.addColorStop(1, "#FFD7BE");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = "#FFF48B"; x.beginPath(); x.arc(W * 0.74, H * 0.32, 120, 0, 7); x.fill();
    x.fillStyle = "rgba(255,235,40,.45)"; x.beginPath(); x.arc(W * 0.74, H * 0.32, 175, 0, 7); x.fill();
    function range(yBase, amp, color) {
      x.fillStyle = color; x.beginPath(); x.moveTo(0, H);
      for (var i = 0; i <= W; i += 28) {
        var y = yBase + Math.sin(i * 0.006) * amp + Math.sin(i * 0.021) * (amp * 0.5);
        x.lineTo(i, y);
      }
      x.lineTo(W, H); x.closePath(); x.fill();
    }
    range(H * 0.60, 60, "#AF7FF4");
    range(H * 0.70, 80, "#8358D4");
    range(H * 0.82, 70, "#543294");
    x.fillStyle = "#3B1F52"; x.fillRect(0, H * 0.86, W, H);
    x.fillStyle = "rgba(255,235,40,.18)"; x.fillRect(W * 0.70, H * 0.86, 90, H);
    x.strokeStyle = "#21152A"; x.lineWidth = 4;
    [[0.30, 0.22], [0.36, 0.18], [0.42, 0.24], [0.20, 0.30]].forEach(function (p) {
      var bx = W * p[0], by = H * p[1];
      x.beginPath(); x.moveTo(bx - 20, by); x.lineTo(bx, by - 12); x.lineTo(bx + 20, by); x.stroke();
    });
    x.fillStyle = "#21152A";
    [0.08, 0.14, 0.91].forEach(function (px) {
      var tx = W * px;
      x.fillRect(tx - 8, H * 0.66, 16, H * 0.34);
      x.beginPath(); x.moveTo(tx, H * 0.52); x.lineTo(tx - 70, H * 0.78); x.lineTo(tx + 70, H * 0.78); x.fill();
      x.beginPath(); x.moveTo(tx, H * 0.60); x.lineTo(tx - 90, H * 0.90); x.lineTo(tx + 90, H * 0.90); x.fill();
    });
    var after = c.toDataURL("image/png");
    lowRes(c, function (before) {
      cb({ name: "mountain-lake.png", w: W, h: H, after: after, before: before, original: after, file: null });
    });
  }

  function lowRes(srcCanvasOrImg, cb) {
    var sw = srcCanvasOrImg.width || srcCanvasOrImg.naturalWidth;
    var sh = srcCanvasOrImg.height || srcCanvasOrImg.naturalHeight;
    var lw = 168, lh = Math.round(lw * sh / sw);
    var small = document.createElement("canvas"); small.width = lw; small.height = lh;
    var sx = small.getContext("2d");
    sx.imageSmoothingEnabled = true; sx.drawImage(srcCanvasOrImg, 0, 0, lw, lh);
    var up = document.createElement("canvas"); up.width = sw; up.height = sh;
    var ux = up.getContext("2d"); ux.imageSmoothingEnabled = true;
    ux.drawImage(small, 0, 0, sw, sh);
    cb(up.toDataURL("image/png"));
  }

  // For the offline sample: rebuild before/after from the CURRENT settings so the
  // upscale factor, sharpness, colour toggle and format visibly take effect.
  function mockProcess(cb) {
    var im = new Image();
    im.onerror = cb;
    im.onload = function () {
      var w = im.naturalWidth, h = im.naturalHeight;
      var sc = Math.min(1, 900 / Math.max(w, h));
      var ww = Math.max(1, Math.round(w * sc)), hh = Math.max(1, Math.round(h * sc));

      // AFTER — sharpness (Soft→Very sharp) + optional colour correction
      var ac = document.createElement("canvas"); ac.width = ww; ac.height = hh;
      var ax = ac.getContext("2d");
      ax.filter = S.detail === 0 ? "blur(0.6px) saturate(.95)"
                : (S.color ? "saturate(1.06) contrast(1.03)" : "none");
      ax.drawImage(im, 0, 0, ww, hh);
      ax.filter = "none";
      if (S.detail >= 2) unsharp(ax, ww, hh, S.detail === 3 ? 0.95 : 0.5);
      var fmt = S.format === "jpg" ? "image/jpeg" : "image/" + S.format;
      S.img.after = ac.toDataURL(fmt, 0.92);

      // BEFORE — degrade more for bigger upscale factors
      var down = Math.max(2, S.factor * 1.6);
      var dw = Math.max(1, Math.round(ww / down)), dh = Math.max(1, Math.round(hh / down));
      var t = document.createElement("canvas"); t.width = dw; t.height = dh;
      t.getContext("2d").drawImage(im, 0, 0, dw, dh);
      var bc = document.createElement("canvas"); bc.width = ww; bc.height = hh;
      var bx = bc.getContext("2d"); bx.imageSmoothingEnabled = true;
      bx.filter = "blur(" + (0.5 + S.factor * 0.25).toFixed(2) + "px) saturate(.85)";
      bx.drawImage(t, 0, 0, ww, hh);
      S.img.before = bc.toDataURL("image/jpeg", 0.9);

      cb();
    };
    im.src = S.img.original;
  }

  // Simple unsharp mask used by the sample preview.
  function unsharp(ctx, w, h, amount) {
    var orig = ctx.getImageData(0, 0, w, h);
    var oc = document.createElement("canvas"); oc.width = w; oc.height = h;
    oc.getContext("2d").putImageData(orig, 0, 0);
    var bc = document.createElement("canvas"); bc.width = w; bc.height = h;
    var bx = bc.getContext("2d"); bx.filter = "blur(1.4px)";
    bx.drawImage(oc, 0, 0);
    var blur = bx.getImageData(0, 0, w, h);
    var o = orig.data, b = blur.data;
    for (var i = 0; i < o.length; i += 4) {
      for (var k = 0; k < 3; k++) {
        var v = o[i + k] + (o[i + k] - b[i + k]) * amount;
        o[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    ctx.putImageData(orig, 0, 0);
  }

  // ── Phase / render ─────────────────────────────────────────────────
  function setPhase(p) { S.phase = p; render(); }

  function render() {
    $all("[data-variant]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.variant === S.variant);
      b.setAttribute("aria-pressed", b.dataset.variant === S.variant);
    });
    $all(".variant").forEach(function (v) {
      v.hidden = !(S.phase === "empty" && v.dataset.v === S.variant);
    });
    var ws = $("#workspace");
    ws.style.display = S.phase === "empty" ? "none" : "grid";
    var sw = $("#switcher"); if (sw) sw.style.display = S.phase === "empty" ? "flex" : "none";
    document.body.classList.toggle("in-workspace", S.phase !== "empty");

    if (S.phase === "empty") return;

    if (S.img) {
      $all(".ws-img").forEach(function (im) { im.src = S.img.after; });
      $("#cmpAfter").src = S.img.after;
      $("#cmpBefore").src = S.img.before;
      $("#fileName").textContent = S.img.name;
      $("#srcDims").textContent = S.img.w + "×" + S.img.h;
      var sp = $("#sharpPrev");
      if (sp && sp.src !== S.img.original) sp.src = S.img.original;
    }

    ws.dataset.phase = S.phase;

    var labels = { selected: "Ready to upscale", processing: "Upscaling…", result: "Upscale complete", error: "Upscale failed" };
    var sl = $("#stageLabel"); if (sl) sl.textContent = labels[S.phase] || "";
    var dotc = { selected: "var(--mint-4)", processing: "var(--lemon-4)", result: "var(--mint-4)", error: "var(--raspberry-4)" };
    var dot = $(".stage-top .dot"); if (dot) dot.style.background = dotc[S.phase] || "var(--mint-4)";

    $all("[data-factor]").forEach(function (b) {
      b.classList.toggle("on", +b.dataset.factor === S.factor);
      b.setAttribute("aria-checked", +b.dataset.factor === S.factor);
    });
    $all("[data-fmt]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.fmt === S.format);
      b.setAttribute("aria-checked", b.dataset.fmt === S.format);
    });
    $("#detailRange").value = S.detail;
    $("#detailLabel").textContent = DETAIL_LABELS[S.detail];
    $all(".detail-stop").forEach(function (s, i) { s.classList.toggle("on", i <= S.detail); });
    var sprev = $("#sharpPrev");
    if (sprev) sprev.style.filter = ["url(#shSoft)", "none", "url(#shSharp)", "url(#shVery)"][S.detail] || "none";
    $("#colorToggle").classList.toggle("on", S.color);
    $("#colorToggle").setAttribute("aria-checked", S.color);

    var d = outDims();
    var dimsStr = d ? (d.w + "×" + d.h) : "—";
    $all(".out-dims").forEach(function (e) { e.textContent = dimsStr; });
    var tier = tierLabel();
    $all(".out-tier").forEach(function (e) { e.textContent = tier; });
    var rf = $("#resFmt"); if (rf) rf.textContent = S.format.toUpperCase();
    var ca = $(".cmp .tag.after"); if (ca) ca.textContent = "After · " + tier;

    if (S.img && d) $("#resTransition").innerHTML =
      S.img.w + "×" + S.img.h + ' <span class="arrow">→</span> ' + d.w + "×" + d.h;

    var dis = S.phase === "processing";
    $all("#panel button, #panel input, #panel select").forEach(function (el) {
      if (el.id === "cancelBtn") return;
      el.disabled = dis;
    });
  }

  // ── Image intake ───────────────────────────────────────────────────
  var OK = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
  function handleFile(file) {
    if (!file) return;
    clearApiKey();   // new image → require the key again
    if (OK.indexOf(file.type) === -1) { showError("Unsupported file — use JPG, PNG or WEBP."); return; }
    if (file.size > MAX_MB * 1024 * 1024) { showError("That file is over " + MAX_MB + " MB. Try a smaller image."); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var im = new Image();
      im.onload = function () {
        if (im.naturalWidth * im.naturalHeight > MAX_PIXELS) {
          showError("Image is too large to upscale to 8K (" + im.naturalWidth + "×" + im.naturalHeight +
                    "). Use one under " + Math.round(MAX_PIXELS / 1e6) + " MP.");
          return;
        }
        lowRes(im, function (before) {
          S.img = {
            name: file.name, w: im.naturalWidth, h: im.naturalHeight,
            after: fr.result, before: before, original: fr.result, file: file
          };
          setPhase("selected");
        });
      };
      im.onerror = function () { showError("Couldn't read that image. Try another file."); };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  function loadSample() {
    clearApiKey();   // Try a sample → require the key again
    var candidates = ["assets/test.jpg", "assets/icons/test.jpg", "test.jpg"];
    var idx = 0;
    (function tryNext() {
      if (idx >= candidates.length) { showError("Couldn't load the sample image."); return; }
      var url = candidates[idx++];
      var im = new Image();
      im.onload = function () {
        // Fetch the same asset as a real File so the sample runs through the
        // real backend — it requires the API key and takes the same time as a
        // normal upload (no more instant offline shortcut).
        fetch(url)
          .then(function (r) { if (!r.ok) throw new Error(); return r.blob(); })
          .then(function (blob) {
            var file = new File([blob], "sample.jpg", { type: blob.type || "image/jpeg" });
            lowRes(im, function (before) {
              S.img = {
                name: "sample.jpg", w: im.naturalWidth, h: im.naturalHeight,
                after: url, before: before, original: url, file: file
              };
              setPhase("selected");
            });
          })
          .catch(function () {
            // Only if the asset can't be fetched (e.g. opened over file://):
            // fall back to the offline demo so the page still works locally.
            lowRes(im, function (before) {
              S.img = {
                name: "sample.jpg", w: im.naturalWidth, h: im.naturalHeight,
                after: url, before: before, original: url, file: null
              };
              setPhase("selected");
            });
          });
      };
      im.onerror = tryNext;   // not at this path — try the next candidate
      im.src = url;
    })();
  }

  function showError(msg) {
    $("#errText").textContent = msg;
    if (S.phase === "empty") {
      $all(".dz").forEach(function (d) { d.classList.add("error"); });
      $all(".dz-err").forEach(function (e) { e.textContent = msg; e.hidden = false; });
      setTimeout(function () {
        $all(".dz").forEach(function (d) { d.classList.remove("error"); });
        $all(".dz-err").forEach(function (e) { e.hidden = true; });
      }, 4200);
      return;
    }
    setPhase("error");
  }

  // ── Progress helpers ───────────────────────────────────────────────
  function setProgress(p, statusText) {
    p = Math.max(0, Math.min(100, p));
    $("#progBar").style.width = p.toFixed(0) + "%";
    $("#progPct").textContent = p.toFixed(0) + "%";
    if (statusText) $("#progStatus").textContent = statusText;
  }
  function curProgress() { return parseFloat($("#progBar").style.width) || 0; }

  // ── REAL upscale (uploads to the backend) ──────────────────────────
  var creepTimer = null, pollTimer = null, curJob = null, aborted = false;
  var procStart = 0, procTick = null, running = false;

  // Messages cycled while the GPU run is in progress (backend gives no %),
  // so a long 8K wait never looks frozen.
  var RUN_MSGS = [
    "Running Seed VR 2…",
    "Reconstructing fine detail…",
    "Rebuilding textures and edges…",
    "Enhancing resolution…",
    "Restoring sharpness…",
    "Still working — high-res upscales take a few minutes…",
    "Hang tight — finalizing your image…"
  ];
  function fmtTime(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }
  function startProcClock() {
    procStart = Date.now();
    clearInterval(procTick);
    procTick = setInterval(function () {
      var el = $("#progElapsed"); if (el) el.textContent = fmtTime(Date.now() - procStart);
      if (running) {
        var i = Math.floor((Date.now() - procStart) / 11000);          // advance ~every 11s
        if (i >= RUN_MSGS.length) i = RUN_MSGS.length - 2 + (i % 2);    // then alternate last two
        var ps = $("#progStatus"); if (ps) ps.textContent = RUN_MSGS[i];
      }
    }, 1000);
  }

  function startUpscale() {
    if (S.img && S.img.file) {
      if (!S.apiKey) { promptForKey(); return; }   // BYOK: real runs need the user's key
      realUpscale();
    } else {
      mockUpscale();              // sample / demo path (offline, no key needed)
    }
  }

  function promptForKey() {
    var card = $("#apiKeyCard"), input = $("#apiKeyInput"), help = $("#apiKeyHelp");
    if (card) { card.classList.add("ak-warn"); try { card.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {} }
    if (help) help.textContent = "Add your Floyo API key to run an upscale.";
    if (input) input.focus();
  }

  function realUpscale() {
    aborted = false; running = false;
    setPhase("processing");
    var big = S.factor >= 4;
    setProgress(2, big ? "Uploading your image…" : "Uploading…");
    startProcClock();

    // creep the bar slowly upward while we wait on the GPU (backend gives no %).
    // Proportional approach toward 96 so it always keeps inching and never hard-freezes.
    var p = 2;
    clearInterval(creepTimer);
    creepTimer = setInterval(function () {
      p = Math.min(96, p + (96 - p) * (big ? 0.015 : 0.03) + 0.05);
      setProgress(p);
    }, 300);

    var fd = new FormData();
    fd.append("file", S.img.file);
    fd.append("upscale_factor", String(S.factor));      // -> ImageScaleBy scale_by
    fd.append("sharpness", DETAIL_KEYS[S.detail]);      // -> LayerFilter enhance
    fd.append("color_correction", S.color ? "true" : "false");
    fd.append("format", S.format);                      // backend converts the result to this

    fetch(API_BASE + "/api/upscale", { method: "POST", body: fd, headers: { "X-Floyo-Key": S.apiKey } })
      .then(function (r) {
        return r.text().then(function (t) {
          var j;
          try { j = JSON.parse(t); }
          catch (e) {
            throw new Error("Backend returned a non-JSON response (HTTP " + r.status +
              "). Is API_BASE pointing at your Flask server?");
          }
          if (!r.ok) throw new Error(j.error || "Upload failed.");
          return j;
        });
      })
      .then(function (j) {
        if (aborted) return;
        curJob = j.job_id;
        setProgress(curProgress(), big ? "Upscaling… this can take a few minutes." : "Upscaling…");
        poll();
      })
      .catch(function (e) {
        stopTimers();
        if (!aborted) showError(e.message || "Couldn't reach the upscaler. Try again.");
      });
  }

  function poll() {
    if (aborted) return;
    fetch(API_BASE + "/api/jobs/" + encodeURIComponent(curJob))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (aborted) return;
        if (j.status === "done") { stopTimers(); finishReal(j); return; }
        if (j.status === "failed") { stopTimers(); showError(j.message || "Upscale failed."); return; }
        if (j.status === "running") { running = true; setProgress(curProgress()); }
        else { running = false; setProgress(curProgress(), j.message || "Working…"); }   // queued / uploading
        pollTimer = setTimeout(poll, 2500);
      })
      .catch(function () {
        if (aborted) return;
        pollTimer = setTimeout(poll, 3500);   // transient network hiccup — keep trying
      });
  }

  function finishReal(job) {
    var out = job.outputs && job.outputs[0];
    if (!out) { showError("The run finished but produced no image."); return; }
    var url = API_BASE + "/api/jobs/" + encodeURIComponent(curJob) + "/files/" + encodeURIComponent(out.id);

    // The result can be a very large file (an 8x PNG is 5120x6400 — tens of MB).
    // Keep the progress overlay up and fully download + decode it BEFORE switching
    // to the result view, so the comparison never appears half-blank.
    running = false;
    setProgress(99, "Downloading your image…");

    var revealed = false;
    function reveal(src) {
      if (revealed) return; revealed = true;
      S.img.before = S.img.original;     // before = your original upload
      S.img.after = src;                 // after  = decoded result (object URL or direct URL)
      S.img.resultUrl = src;
      S.img.resultName = out.name || "upscaled.png";
      setProgress(100, "Done!");
      setPhase("result"); setSlider(50);
    }

    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error("fetch failed"); return r.blob(); })
      .then(function (blob) {
        var obj = URL.createObjectURL(blob);
        var im = new Image();                 // decode before revealing
        im.onload = function () { reveal(obj); };
        im.onerror = function () { reveal(obj); };
        im.src = obj;
      })
      .catch(function () { reveal(url); });    // fallback: let the <img> load it directly

    setTimeout(function () { reveal(url); }, 120000);   // ultimate safety net
  }

  function stopTimers() { clearInterval(creepTimer); clearTimeout(pollTimer); clearInterval(procTick); running = false; }

  // ── MOCK upscale (offline demo for sample / URL only) ──────────────
  function mockUpscale() {
    setPhase("processing");
    var p = 0;
    var bar = $("#progBar"), pct = $("#progPct"), status = $("#progStatus");
    var big = S.factor >= 4;
    status.textContent = big ? "Upscaling… this can take a moment" : "Upscaling your image…";
    running = false; startProcClock();
    clearInterval(creepTimer);
    creepTimer = setInterval(function () {
      var step = (100 - p) * (big ? 0.06 : 0.11) + Math.random() * 2;
      p = Math.min(100, p + step);
      bar.style.width = p.toFixed(0) + "%";
      pct.textContent = p.toFixed(0) + "%";
      if (p > 35 && p < 75) status.textContent = "Reconstructing fine detail…";
      if (p >= 75 && p < 99) status.textContent = "Applying sharpening pass…";
      if (p >= 100) {
        clearInterval(creepTimer); clearInterval(procTick);
        mockProcess(function () { setPhase("result"); setSlider(50); });
      }
    }, 220);
  }

  function cancelUpscale() {
    aborted = true; stopTimers();
    $("#progBar").style.width = "0%";
    setPhase("selected");
  }

  // ── Before/After slider ────────────────────────────────────────────
  function setSlider(pctVal) {
    pctVal = Math.max(0, Math.min(100, pctVal));
    $("#cmpClip").style.clipPath = "inset(0 " + (100 - pctVal) + "% 0 0)";
    $("#cmpHandle").style.left = pctVal + "%";
    // Reflect what's actually on screen: all-before (handle far right),
    // all-after (handle far left), or both while comparing in between.
    var bf = document.querySelector(".cmp .tag.before");
    var af = document.querySelector(".cmp .tag.after");
    if (bf && af) {
      bf.style.opacity = pctVal <= 2 ? "0" : "1";   // nothing of "before" visible
      af.style.opacity = pctVal >= 98 ? "0" : "1";  // nothing of "after" visible
    }
  }
  function bindSlider() {
    var frame = $("#cmpFrame"), dragging = false;
    function fromEvent(e) {
      var r = frame.getBoundingClientRect();
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      setSlider(((clientX - r.left) / r.width) * 100);
    }
    function down(e) { dragging = true; fromEvent(e); e.preventDefault(); }
    function move(e) { if (dragging) fromEvent(e); }
    function up() { dragging = false; }
    $("#cmpHandle").addEventListener("mousedown", down);
    $("#cmpHandle").addEventListener("touchstart", down, { passive: false });
    frame.addEventListener("mousedown", down);
    frame.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);

    // Hover-to-compare: on devices with a real pointer, the divider follows the
    // cursor whenever it's over the image — no click or drag needed.
    var hoverCapable = !window.matchMedia || window.matchMedia("(hover: hover)").matches;
    if (hoverCapable) frame.addEventListener("mousemove", fromEvent);
    $("#cmpHandle").addEventListener("keydown", function (e) {
      var cur = parseFloat($("#cmpHandle").style.left) || 50;
      if (e.key === "ArrowLeft") { setSlider(cur - 4); e.preventDefault(); }
      if (e.key === "ArrowRight") { setSlider(cur + 4); e.preventDefault(); }
    });
  }

  function reset() {
    aborted = true; stopTimers();
    clearApiKey();   // Change image / remove → require the key again
    S.img = null; S.phase = "empty"; render();
  }

  // ── Download ───────────────────────────────────────────────────────
  function downloadResult() {
    if (!S.img) return;
    if (S.img.resultUrl) {                       // real backend result
      fetch(S.img.resultUrl).then(function (r) { return r.blob(); }).then(function (b) {
        var u = URL.createObjectURL(b);
        var a = document.createElement("a");
        a.href = u;
        a.download = S.img.resultName || (S.img.name.replace(/\.[^.]+$/, "") + "-upscaled.png");
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
      }).catch(function () { window.open(S.img.resultUrl, "_blank"); });
    } else {                                      // offline demo
      var a = document.createElement("a");
      a.href = S.img.after;
      a.download = S.img.name.replace(/\.[^.]+$/, "") + "-upscaled-" + S.factor + "x." + S.format;
      a.click();
    }
  }

  // ── Wire up ────────────────────────────────────────────────────────
  // ── Floyo API key (bring-your-own-key) ─────────────────────────────────
  // Held ONLY in memory and never persisted: a refresh, a new image, "Change
  // image", or "Try a sample" all clear it, so the user re-enters it each time.
  function markKey() {
    var card = $("#apiKeyCard"), help = $("#apiKeyHelp");
    if (!card) return;
    card.classList.toggle("ok", !!S.apiKey);
    if (S.apiKey) {
      card.classList.remove("ak-warn");
      if (help) help.textContent = "Used to run this workflow on your account.";
    }
  }
  function clearApiKey() {
    S.apiKey = "";
    var input = $("#apiKeyInput"), card = $("#apiKeyCard"), help = $("#apiKeyHelp"), toggle = $("#apiKeyToggle");
    if (input) { input.value = ""; input.type = "password"; }
    if (toggle) { toggle.setAttribute("title", "Show key"); toggle.setAttribute("aria-label", "Show key"); }
    if (card) card.classList.remove("ok", "ak-warn");
    if (help) help.textContent = "Used to run this workflow on your account.";
  }
  function setupApiKey() {
    var input = $("#apiKeyInput"), toggle = $("#apiKeyToggle");
    if (!input) return;
    S.apiKey = "";            // always start empty — never restored
    input.value = "";
    markKey();
    input.addEventListener("input", function () {
      S.apiKey = input.value.trim();
      markKey();
    });
    if (toggle) toggle.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.setAttribute("title", show ? "Hide key" : "Show key");
      toggle.setAttribute("aria-label", show ? "Hide key" : "Show key");
    });
  }

  function init() {
    $all("[data-variant]").forEach(function (b) {
      b.addEventListener("click", function () { S.variant = b.dataset.variant; render(); });
    });

    $("#fileInput").addEventListener("change", function (e) {
      var f = e.target.files[0];
      e.target.value = "";   // reset so picking the SAME file again still fires change
      handleFile(f);
    });
    $all(".browse").forEach(function (b) {
      b.addEventListener("click", function () { $("#fileInput").click(); });
    });
    $all(".sample-link").forEach(function (b) { b.addEventListener("click", loadSample); });

    $all(".dz").forEach(function (dz) {
      ["dragenter", "dragover"].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("drag"); });
      });
      ["dragleave", "dragend"].forEach(function (ev) {
        dz.addEventListener(ev, function (e) { if (e.target === dz) dz.classList.remove("drag"); });
      });
      dz.addEventListener("drop", function (e) {
        e.preventDefault(); dz.classList.remove("drag");
        handleFile(e.dataTransfer.files[0]);
      });
    });
    window.addEventListener("paste", function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") === 0) { handleFile(items[i].getAsFile()); break; }
      }
    });

    $all("[data-factor]").forEach(function (b) {
      b.addEventListener("click", function () { S.factor = +b.dataset.factor; render(); });
    });
    $all("[data-fmt]").forEach(function (b) {
      b.addEventListener("click", function () { S.format = b.dataset.fmt; render(); });
    });
    $("#detailRange").addEventListener("input", function (e) { S.detail = +e.target.value; render(); });
    $("#colorToggle").addEventListener("click", function () { S.color = !S.color; render(); });

    $("#advToggle").addEventListener("click", function () {
      var open = $("#advBody").hidden;
      $("#advBody").hidden = !open;
      $("#advToggle").setAttribute("aria-expanded", open);
      $("#advToggle").classList.toggle("open", open);
    });

    $("#upscaleBtn").addEventListener("click", startUpscale);
    setupApiKey();
    $("#cancelBtn").addEventListener("click", cancelUpscale);
    $("#downloadBtn").addEventListener("click", downloadResult);
    $all(".tryanother").forEach(function (b) { b.addEventListener("click", reset); });
    $("#retryBtn").addEventListener("click", function () { setPhase(S.img ? "selected" : "empty"); });
    $("#changeImg").addEventListener("click", reset);

    bindSlider();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();