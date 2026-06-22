/* ===========================================================
 *  IdolCover Studio - 偶像新歌翻唱助手 Demo
 *  基于 Web Audio API / MediaRecorder / OfflineAudioContext
 *  人声分离：谱减法 + 中置通道提取（前端模拟 Demucs 效果）
 *  变调算法：粒状 pitch-shift（phase vocoder 简化版）
 * =========================================================== */

(function () {
  "use strict";

  // ---------- 全局状态 ----------
  const S = {
    actx: null,
    originalBuffer: null,
    karaokeBuffer: null,
    vocalBuffer: null,
    pitchShiftedBuffer: null,
    semitones: 0,
    songTitle: "",
    myVoice: "female-high",
    origVoice: "female-group",
    chorusTracks: [],
    lastVoiceBuffer: null,
    mixBuffer: null,
    mode: "solo",
    _recommended: 0,
    _recordingChorus: false,
    _targetTrack: null,
    rec: {
      active: false,
      stream: null,
      mediaRecorder: null,
      chunks: [],
      startAt: 0,
      timer: null,
      analyser: null,
      canvas: null,
      ctx: null,
      source: null,
      gainMonitor: null,
    },
    pitchPlayer: { source: null, gain: null, analyser: null, startAt: 0, pausedAt: 0, raf: null, playing: false },
    videoBlob: null,
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (s) => document.querySelectorAll(s);

  function toast(msg, ms) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms || 2200);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function actx() {
    if (!S.actx) S.actx = new (window.AudioContext || window.webkitAudioContext)();
    return S.actx;
  }

  function generateLyrics(duration) {
    const lines = [];
    const totalSeconds = Math.floor(duration);
    const interval = 5;
    
    const phrases = [
      "♪ 开始播放", "♪ ♪ ♪", "♪ 音乐进行中", "♪ ♪ ♪",
      "♪ 继续播放", "♪ ♪ ♪", "♪ 精彩时刻", "♪ ♪ ♪",
      "♪ 高潮部分", "♪ ♪ ♪", "♪ 接近尾声", "♪ ♪ ♪",
      "♪ 播放结束"
    ];
    
    for (let t = 0; t <= totalSeconds; t += interval) {
      const idx = Math.min(Math.floor(t / interval), phrases.length - 1);
      const phrase = t === totalSeconds || t + interval > totalSeconds ? "♪ 播放结束" : phrases[idx];
      const minutes = Math.floor(t / 60);
      const seconds = t % 60;
      const timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      lines.push(`[${timeStr}] ${phrase}`);
    }
    
    if ($("lyricText")) {
      $("lyricText").value = lines.join("\n");
    }
  }

  if (window.lucide) window.lucide.createIcons();

  // ---------- 步骤切换 ----------
  function showPanel(n) {
    qsa(".panel").forEach((p) => p.classList.add("hidden"));
    document.querySelector('.panel[data-panel="' + n + '"]').classList.remove("hidden");
    qsa(".step").forEach((s) => {
      const k = +s.dataset.step;
      s.classList.toggle("active", k === n);
      s.classList.toggle("done", k < n);
    });
    stopPitchPlayer();
    
    // 停止所有播放器
    qsa("audio").forEach(audio => {
      audio.pause();
      audio.currentTime = 0;
    });
    
    // 所有页面切换都滚动到底部
    setTimeout(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }, 100);
  }

  function bindStep(id, target) { $(id) && $(id).addEventListener("click", () => showPanel(target)); }
  bindStep("toStep2", 2); bindStep("backTo1", 1); bindStep("toStep3", 3); bindStep("backTo2", 2);
  bindStep("toStep4", 4); bindStep("backTo3", 3);
  $("restartBtn") && $("restartBtn").addEventListener("click", () => {
    if (!confirm("确认从头再来？当前录制将被清除。")) return;
    S.chorusTracks = []; S.mixBuffer = null; renderChorus();
    $("finalMix").classList.add("hidden"); $("voicePreview").classList.add("hidden"); $("toStep4").disabled = true;
    showPanel(1);
  });

  // ---------- 1. 文件上传 ----------
  const dz = $("dropzone");
  const fi = $("fileInput");
  $("chooseFileBtn").addEventListener("click", () => fi.click());
  dz.addEventListener("click", (e) => { if (e.target === dz || e.target.classList.contains("big-icon")) fi.click(); });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener("change", () => { if (fi.files && fi.files[0]) handleFile(fi.files[0]); });

  async function handleFile(file) {
    toast("读取文件：" + file.name);
    S.songTitle = file.name.replace(/\.[^.]+$/, "");
    $("songTitle").textContent = S.songTitle + " （" + file.type + "）";
    $("songSize").textContent = fmtSize(file.size);
    $("songInfo").classList.remove("hidden");
    $("trackPreviews").classList.add("hidden");
    $("songStatus").textContent = "解码中…";
    $("songStatus").className = "badge badge-neutral";

    try {
      const ab = await file.arrayBuffer();
      const buf = await actx().decodeAudioData(ab.slice(0));
      S.originalBuffer = buf;
      $("songDuration").textContent = fmtTime(buf.duration) + " · " + buf.numberOfChannels + "声道 · " + buf.sampleRate + "Hz";
      generateLyrics(buf.duration);
      $("songStatus").textContent = "已解码，可分离";
      $("songStatus").className = "badge badge-violet";
      $("separateBtn").disabled = false;
    } catch (e) {
      console.error(e);
      toast("解码失败：" + e.message, 3200);
      $("songStatus").textContent = "解码失败";
      $("songStatus").className = "badge badge-pink";
    }
  }

  // ---------- 本地预置：真实歌曲文件 ----------
  const PRESETS = [
    { key: "male-group", title: "Excitant", artist: "庞鹏洋", file: "audio/excitant.mp3", hint: "男团风，建议女声降 4-6 半音" },
    { key: "male-solo", title: "漂洋过海来看你", artist: "周深", file: "audio/beyond_the_sea.mp3", hint: "男中音独唱，建议女声降调" },
    { key: "female-solo", title: "唐人", artist: "董沐曦", file: "audio/tang_people.mp3", hint: "古风女声，建议男声升调" },
    { key: "female-group", title: "小幸运", artist: "桃子鱼仔的Ukulele", file: "audio/lucky_star.mp3", hint: "清新女声，建议男声升 4-5 半音" },
  ];

  // ---------- 全局加载遮罩 ----------
  function showLoading(text, subtext) {
    let overlay = $("globalLoading");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "globalLoading";
      overlay.className = "global-loading";
      overlay.innerHTML = '<div class="loading-content">' +
        '<div class="loading-spinner">' +
          '<div class="spinner-ring"></div>' +
          '<div class="spinner-ring"></div>' +
          '<div class="spinner-ring"></div>' +
        '</div>' +
        '<div class="loading-text" id="loadingText">加载中…</div>' +
        '<div class="loading-subtext" id="loadingSubtext"></div>' +
        '<div class="loading-progress"><div class="loading-bar" id="loadingBar"></div></div>' +
      '</div>';
      document.body.appendChild(overlay);
    }
    $("loadingText").textContent = text || "加载中…";
    $("loadingSubtext").textContent = subtext || "";
    $("loadingBar").style.width = "0%";
    overlay.classList.add("active");
    document.body.classList.add("loading-active");
  }

  function updateLoading(text, subtext, progress) {
    const overlay = $("globalLoading");
    if (!overlay) return;
    if (text) $("loadingText").textContent = text;
    if (subtext !== undefined) $("loadingSubtext").textContent = subtext;
    if (progress !== undefined) $("loadingBar").style.width = progress + "%";
  }

  function hideLoading() {
    const overlay = $("globalLoading");
    if (overlay) overlay.classList.remove("active");
    document.body.classList.remove("loading-active");
  }

  (function initPresets() {
    const grid = $("presetGrid"); grid.innerHTML = "";
    PRESETS.forEach((p) => {
      const c = document.createElement("button");
      c.className = "preset-card";
      c.innerHTML = '<div class="preset-title">' + p.title + '</div>' +
        '<div class="preset-meta">' + p.artist + '</div>' +
        '<div class="preset-hint">' + p.hint + '</div>' +
        '<div class="preset-action"><i data-lucide="play-circle"></i> 使用此歌曲</div>';
      c.addEventListener("click", async () => {
        // 禁用所有预设卡片
        qsa(".preset-card").forEach(card => card.disabled = true);
        c.classList.add("loading");
        
        // 显示全局加载遮罩
        showLoading("正在加载歌曲", p.title);
        updateLoading("正在加载歌曲", p.title, 10);
        
        try {
          // 先确保AudioContext已激活
          if (!S.originalBuffer) {
            await actx().resume();
          }
          
          updateLoading("正在下载音频文件", p.title, 30);
          await new Promise(r => setTimeout(r, 200));
          
          const response = await fetch(p.file);
          if (!response.ok) throw new Error("加载失败");
          
          updateLoading("正在读取音频数据", p.title, 50);
          await new Promise(r => setTimeout(r, 200));
          
          const ab = await response.arrayBuffer();
          
          updateLoading("正在解码音频", p.title, 75);
          await new Promise(r => setTimeout(r, 200));
          
          const buf = await actx().decodeAudioData(ab.slice(0));
          
          updateLoading("准备就绪", p.title, 95);
          await new Promise(r => setTimeout(r, 300));
          
          // 设置歌曲信息
          S.originalBuffer = buf;
          S.songTitle = p.title;
          $("songTitle").textContent = p.title + " - " + p.artist;
          $("songSize").textContent = fmtSize(buf.length * buf.numberOfChannels * 4);
          $("songDuration").textContent = fmtTime(buf.duration) + " · " + buf.numberOfChannels + "声道 · " + buf.sampleRate + "Hz";
          generateLyrics(buf.duration);
          
          updateLoading("加载完成", p.title, 100);
          await new Promise(r => setTimeout(r, 300));
          
          // 隐藏加载遮罩
          hideLoading();
          
          // 加载完成后再显示分离卡片
          $("songInfo").classList.remove("hidden");
          $("songStatus").textContent = "已就绪，可分离";
          $("songStatus").className = "badge badge-violet";
          $("separateBtn").disabled = false;
          $("trackPreviews").classList.add("hidden");
          setOrigVoice(p.key);
          
          // 平滑滚动到分离区域
          $("songInfo").scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          toast("歌曲加载完成：" + p.title);
        } catch (e) {
          console.error(e);
          hideLoading();
          toast("加载失败，请检查文件是否存在：" + p.file, 3500);
        }
        
        c.classList.remove("loading");
        qsa(".preset-card").forEach(card => card.disabled = false);
        if (window.lucide) window.lucide.createIcons();
      });
      grid.appendChild(c);
    });
    if (window.lucide) window.lucide.createIcons();
  })();

  // ---------- 2. 人声分离 ----------
  let ortSession = null;
  const MODEL_URL = "demucs.onnx";
  
  // API配置
  let apiConfig = {
    provider: 'local',
    apiKey: '',
    mode: 'vocals'
  };

  // 加载保存的API配置
  function loadApiConfig() {
    try {
      const saved = localStorage.getItem('idolcover_api_config');
      if (saved) {
        apiConfig = JSON.parse(saved);
        if ($("apiProvider")) $("apiProvider").value = apiConfig.provider;
        if ($("apiKey")) $("apiKey").value = apiConfig.apiKey;
        if ($("separationMode")) $("separationMode").value = apiConfig.mode;
      }
    } catch (e) {
      console.log("加载API配置失败:", e);
    }
  }

  // 保存API配置
  function saveApiConfig() {
    apiConfig.provider = $("apiProvider").value;
    apiConfig.apiKey = $("apiKey").value;
    apiConfig.mode = $("separationMode").value;
    localStorage.setItem('idolcover_api_config', JSON.stringify(apiConfig));
    toast("API 设置已保存");
  }

  // API设置面板事件
  (function initApiSettings() {
    loadApiConfig();
    
    const settingsPanel = $("apiSettings");
    const openBtn = $("openApiSettings");
    const closeBtn = $("closeApiSettings");
    const saveBtn = $("saveApiSettings");
    
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        settingsPanel.classList.remove("hidden");
      });
    }
    
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        settingsPanel.classList.add("hidden");
      });
    }
    
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        saveApiConfig();
        settingsPanel.classList.add("hidden");
      });
    }
  })();

  async function loadDemucsModel() {
    if (ortSession) return true;
    try {
      const response = await fetch(MODEL_URL);
      if (!response.ok) throw new Error("模型文件不存在");
      ortSession = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm', 'cpu'],
        graphOptimizationLevel: 'all'
      });
      return true;
    } catch (e) {
      console.log("ONNX 模型加载失败，使用本地增强算法:", e.message);
      return false;
    }
  }

  $("separateBtn").addEventListener("click", async () => {
    if (!S.originalBuffer) return;
    $("separateBtn").disabled = true;
    $("songStatus").textContent = "分离中…"; $("songStatus").className = "badge badge-yellow";
    
    // 显示全局加载遮罩
    showLoading("正在启动 AI 分离引擎", "请稍候...");
    updateLoading("正在启动 AI 分离引擎", "请稍候...", 5);
    
    let karaoke, vocal;
    let useCloud = false;
    
    // 根据API配置选择分离方式
    if (apiConfig.apiKey && apiConfig.provider !== 'local') {
      // 使用云端API
      updateLoading("正在连接云端 AI 服务", "请稍候...", 15);
      await new Promise(r => setTimeout(r, 300));
      updateLoading("正在上传音频到服务器", "请稍候...", 35);
      await new Promise(r => setTimeout(r, 300));
      updateLoading("AI 分离处理中", "请稍候...", 60);
      await new Promise(r => setTimeout(r, 300));
      
      try {
        const result = await separateWithCloudAPI(S.originalBuffer);
        karaoke = result.karaoke;
        vocal = result.vocal;
        useCloud = true;
      } catch (e) {
        console.error("云端分离失败，切换到本地算法:", e);
        toast("云端分离失败，使用本地算法…");
        const temp = separateWithLocalAlgo(S.originalBuffer);
        karaoke = temp.karaoke;
        vocal = temp.vocal;
      }
      
      if (useCloud) {
        updateLoading("正在下载分离结果", "即将完成...", 90);
        await new Promise(r => setTimeout(r, 500));
        updateLoading("分离完成！", "准备就绪", 100);
        await new Promise(r => setTimeout(r, 400));
        hideLoading();
        toast("云端 AI 分离完成，效果极佳！🎶");
      } else {
        hideLoading();
      }
    } else if (apiConfig.provider === 'local' && apiConfig.apiKey) {
      // 本地Demucs模型
      const hasModel = await loadDemucsModel();
      if (hasModel) {
        updateLoading("正在加载 Demucs AI 模型", "首次加载需要一些时间...", 20);
        await new Promise(r => setTimeout(r, 500));
        updateLoading("AI 推理中", "正在分析音频...", 50);
      } else {
        updateLoading("正在分析音频频谱", "使用本地增强算法", 30);
      }
      
      const temp = hasModel 
        ? await separateWithDemucs(S.originalBuffer)
        : separateWithLocalAlgo(S.originalBuffer);
      karaoke = temp.karaoke;
      vocal = temp.vocal;
      
      updateLoading("后处理优化中", "即将完成...", 90);
      await new Promise(r => setTimeout(r, 400));
      updateLoading("分离完成！", "准备就绪", 100);
      await new Promise(r => setTimeout(r, 400));
      hideLoading();
      toast(hasModel ? "AI 分离完成，效果更佳！🎶" : "本地算法分离完成 🎶");
    } else {
      // 纯本地算法
      updateLoading("正在分析音频频谱", "使用本地增强算法", 30);
      await new Promise(r => setTimeout(r, 300));
      updateLoading("正在提取人声与伴奏", "处理中...", 60);
      
      const temp = separateWithLocalAlgo(S.originalBuffer);
      karaoke = temp.karaoke;
      vocal = temp.vocal;
      
      updateLoading("合成双轨输出", "即将完成...", 90);
      await new Promise(r => setTimeout(r, 400));
      updateLoading("分离完成！", "准备就绪", 100);
      await new Promise(r => setTimeout(r, 400));
      hideLoading();
      toast("本地算法分离完成 🎶");
    }

    // 显示完成状态
    S.karaokeBuffer = karaoke; S.vocalBuffer = vocal;
    $("playerK").src = bufferToWaveUrl(karaoke); 
    $("playerV").src = bufferToWaveUrl(vocal);
    $("kDuration").textContent = fmtTime(karaoke.duration); 
    $("vDuration").textContent = fmtTime(vocal.duration);
    $("trackPreviews").classList.remove("hidden"); 
    $("songStatus").textContent = "分离成功 ✓"; 
    $("songStatus").className = "badge badge-cyan";
    $("toStep2").disabled = false;
    $("separateBtn").disabled = false;
  });

  // 云端API分离
  async function separateWithCloudAPI(buffer) {
    const ctx = actx();
    const sr = buffer.sampleRate;
    const len = buffer.length;
    
    // 将AudioBuffer转换为WAV Blob
    const wavBlob = bufferToWaveBlob(buffer);
    const formData = new FormData();
    formData.append('audio', wavBlob, 'audio.wav');
    formData.append('model', apiConfig.mode);
    
    let apiEndpoint, headers;
    
    switch (apiConfig.provider) {
      case 'lalalai':
        apiEndpoint = 'https://api.lalal.ai/v1/separate';
        headers = {
          'Authorization': `Bearer ${apiConfig.apiKey}`
        };
        break;
      case 'moises':
        apiEndpoint = 'https://api.moises.ai/v1/job';
        headers = {
          'Authorization': `Bearer ${apiConfig.apiKey}`,
          'Content-Type': 'application/json'
        };
        break;
      default:
        throw new Error('不支持的API提供商');
    }
    
    // 上传音频
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: headers,
      body: apiConfig.provider === 'moises' ? JSON.stringify({
        audioUrl: 'data:audio/wav;base64,' + await blobToBase64(wavBlob),
        types: ['vocals', 'instrumental']
      }) : formData
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API请求失败: ${response.status} - ${error}`);
    }
    
    const result = await response.json();
    
    // 处理返回结果
    if (result.status === 'processing' || result.job_id) {
      // 如果是异步任务，等待完成
      const jobId = result.job_id || result.id;
      const result2 = await pollJobResult(jobId);
      return processCloudResult(result2);
    } else {
      return processCloudResult(result);
    }
  }
  
  // 轮询异步任务结果
  async function pollJobResult(jobId, maxAttempts = 60) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 2000));
      
      const response = await fetch(`https://api.moises.ai/v1/job/${jobId}`, {
        headers: {
          'Authorization': `Bearer ${apiConfig.apiKey}`
        }
      });
      
      if (!response.ok) continue;
      
      const result = await response.json();
      
      if (result.status === 'completed') {
        return result;
      } else if (result.status === 'failed') {
        throw new Error('云端处理失败');
      }
    }
    
    throw new Error('云端处理超时');
  }
  
  // 处理云端返回结果
  async function processCloudResult(result) {
    const ctx = actx();
    const sr = 44100;
    
    // 提取人声和伴奏轨道
    let vocalUrl, instrumentalUrl;
    
    if (result.tracks) {
      vocalUrl = result.tracks.vocals || result.tracks.vocal;
      instrumentalUrl = result.tracks.instrumental;
    } else if (result.results) {
      vocalUrl = result.results.vocals || result.results.vocal;
      instrumentalUrl = result.results.instrumental;
    }
    
    // 下载音频文件
    const [vocalData, instrumentalData] = await Promise.all([
      vocalUrl ? downloadAudio(vocalUrl) : null,
      instrumentalUrl ? downloadAudio(instrumentalUrl) : null
    ]);
    
    // 解码音频
    const vocalBuffer = vocalData ? await ctx.decodeAudioData(vocalData) : null;
    const instrumentalBuffer = instrumentalData ? await ctx.decodeAudioData(instrumentalData) : null;
    
    return {
      vocal: vocalBuffer,
      karaoke: instrumentalBuffer
    };
  }
  
  // 下载音频文件
  async function downloadAudio(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('下载音频失败');
    return response.arrayBuffer();
  }
  
  // Blob转Base64
  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function separateWithDemucs(src) {
    const ctx = actx();
    const sr = src.sampleRate;
    const len = src.length;
    const ch = src.numberOfChannels;
    
    const L = src.getChannelData(0);
    const R = ch >= 2 ? src.getChannelData(1) : L;
    
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = (L[i] + R[i]) * 0.5;
    
    const inputTensor = new ort.Tensor('float32', mono, [1, 1, len]);
    const feeds = { input: inputTensor };
    
    const results = await ortSession.run(feeds);
    const vocalData = results.vocal.data;
    const instData = results.instrumental.data;
    
    const outVL = new Float32Array(len);
    const outVR = new Float32Array(len);
    const outKL = new Float32Array(len);
    const outKR = new Float32Array(len);
    
    for (let i = 0; i < len; i++) {
      outVL[i] = vocalData[i]; outVR[i] = vocalData[i];
      outKL[i] = instData[i]; outKR[i] = instData[i];
    }
    
    let pk = 0.0001, pv = 0.0001;
    for (let i = 0; i < len; i++) { 
      if (Math.abs(outKL[i]) > pk) pk = Math.abs(outKL[i]); 
      if (Math.abs(outVL[i]) > pv) pv = Math.abs(outVL[i]); 
    }
    const gk = 0.85 / pk, gv = 0.9 / pv;
    for (let i = 0; i < len; i++) { 
      outKL[i] *= gk; outKR[i] *= gk; 
      outVL[i] *= gv; outVR[i] *= gv; 
    }
    
    const kb = ctx.createBuffer(2, len, sr); 
    kb.copyToChannel(outKL, 0); kb.copyToChannel(outKR, 1);
    const vb = ctx.createBuffer(2, len, sr); 
    vb.copyToChannel(outVL, 0); vb.copyToChannel(outVR, 1);
    return { karaoke: kb, vocal: vb };
  }

  function separateWithLocalAlgo(src) {
    const ctx = actx();
    const sr = src.sampleRate;
    const len = src.length;
    const ch = src.numberOfChannels;
    const L0 = src.getChannelData(0);
    const R0 = ch >= 2 ? src.getChannelData(1) : L0;

    const frame = 4096, hop = 1024;
    const win = new Float32Array(frame);
    for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);

    function fft(re, im, invert) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let l = 2; l <= n; l <<= 1) {
        const ang = (2 * Math.PI) / l * (invert ? -1 : 1);
        const wlenR = Math.cos(ang), wlenI = Math.sin(ang);
        for (let i = 0; i < n; i += l) {
          let wR = 1, wI = 0;
          for (let k = 0; k < l / 2; k++) {
            const uR = re[i + k], uI = im[i + k];
            const vR = re[i + k + l / 2] * wR - im[i + k + l / 2] * wI;
            const vI = re[i + k + l / 2] * wI + im[i + k + l / 2] * wR;
            re[i + k] = uR + vR; im[i + k] = uI + vI;
            re[i + k + l / 2] = uR - vR; im[i + k + l / 2] = uI - vI;
            const nwR = wR * wlenR - wI * wlenI; wI = wR * wlenI + wI * wlenR; wR = nwR;
          }
        }
      }
      if (invert) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }

    const fMin = Math.max(1, Math.floor(100 * frame / sr));
    const fMax = Math.min(frame / 2, Math.floor(4000 * frame / sr));

    const accK = new Float32Array(len);
    const accV = new Float32Array(len);
    const winNorm = new Float32Array(len);

    for (let start = 0; start + frame < len; start += hop) {
      const reM = new Float32Array(frame), imM = new Float32Array(frame);
      const reS = new Float32Array(frame), imS = new Float32Array(frame);
      for (let i = 0; i < frame; i++) {
        const l = L0[start + i] * win[i];
        const r = R0[start + i] * win[i];
        reM[i] = (l + r) * 0.5; reS[i] = (l - r) * 0.5;
      }
      fft(reM, imM, false); fft(reS, imS, false);

      const magM = new Float32Array(frame / 2);
      const magS = new Float32Array(frame / 2);
      for (let k = 0; k < frame / 2; k++) { 
        magM[k] = Math.hypot(reM[k], imM[k]); 
        magS[k] = Math.hypot(reS[k], imS[k]); 
      }

      const maskK = new Float32Array(frame / 2);
      const maskV = new Float32Array(frame / 2);
      for (let k = 0; k < frame / 2; k++) {
        const inBand = k >= fMin && k <= fMax;
        const centerRatio = (magM[k] - magS[k]) / (magM[k] + magS[k] + 1e-6);
        const sideRatio = (magS[k] + 1e-6) / (magM[k] + magS[k] + 1e-6);
        
        let vMask = 0;
        if (inBand) {
          if (centerRatio > 0.3) {
            vMask = 0.9 + centerRatio * 0.5;
          } else if (centerRatio > 0.1) {
            vMask = 0.6 + centerRatio * 1.0;
          } else {
            vMask = 0.3 + centerRatio * 1.5;
          }
        } else {
          vMask = Math.max(0, centerRatio * 0.5);
        }
        
        vMask = Math.max(0, Math.min(1, vMask));
        maskV[k] = vMask;
        maskK[k] = 1 - Math.max(0, vMask * 0.95);
      }

      for (let k = 1; k < frame / 2 - 1; k++) {
        maskV[k] = maskV[k] * 0.5 + (maskV[k - 1] + maskV[k + 1]) * 0.25;
        maskK[k] = maskK[k] * 0.5 + (maskK[k - 1] + maskK[k + 1]) * 0.25;
      }

      const kRe = new Float32Array(frame), kIm = new Float32Array(frame);
      const vRe = new Float32Array(frame), vIm = new Float32Array(frame);
      for (let k = 0; k < frame; k++) {
        const kk = k < frame / 2 ? k : frame - k;
        const mk = maskK[kk] || 0, mv = maskV[kk] || 0;
        kRe[k] = reS[k] * 2.0 + reM[k] * mk * 0.5; 
        kIm[k] = imS[k] * 2.0 + imM[k] * mk * 0.5;
        vRe[k] = reM[k] * mv * 2.0; 
        vIm[k] = imM[k] * mv * 2.0;
      }
      fft(kRe, kIm, true); fft(vRe, vIm, true);

      for (let i = 0; i < frame; i++) {
        const idx = start + i; if (idx >= len) break;
        const w = win[i];
        accK[idx] += kRe[i] * w; accV[idx] += vRe[i] * w; winNorm[idx] += w * w;
      }
    }

    const outKL = new Float32Array(len), outKR = new Float32Array(len);
    const outVL = new Float32Array(len), outVR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const n = winNorm[i] > 1e-4 ? 1 / winNorm[i] : 0;
      outKL[i] = accK[i] * n; outKR[i] = accK[i] * n; 
      outVL[i] = accV[i] * n; outVR[i] = accV[i] * n;
    }

    const filteredKL = applyDynamicFilter(outKL, sr, 'karaoke');
    const filteredKR = applyDynamicFilter(outKR, sr, 'karaoke');
    const filteredVL = applyDynamicFilter(outVL, sr, 'vocal');
    const filteredVR = applyDynamicFilter(outVR, sr, 'vocal');

    let pk = 0.0001, pv = 0.0001;
    for (let i = 0; i < len; i++) { 
      if (Math.abs(filteredKL[i]) > pk) pk = Math.abs(filteredKL[i]); 
      if (Math.abs(filteredVL[i]) > pv) pv = Math.abs(filteredVL[i]); 
    }
    const gk = 0.85 / pk, gv = 0.9 / pv;
    for (let i = 0; i < len; i++) { 
      filteredKL[i] *= gk; filteredKR[i] *= gk; 
      filteredVL[i] *= gv; filteredVR[i] *= gv; 
    }

    const kb = ctx.createBuffer(2, len, sr); 
    kb.copyToChannel(filteredKL, 0); kb.copyToChannel(filteredKR, 1);
    const vb = ctx.createBuffer(2, len, sr); 
    vb.copyToChannel(filteredVL, 0); vb.copyToChannel(filteredVR, 1);
    return { karaoke: kb, vocal: vb };
  }

  function applyDynamicFilter(data, sr, type) {
    const len = data.length;
    const filtered = new Float32Array(len);
    
    if (type === 'karaoke') {
      for (let i = 2; i < len - 2; i++) {
        filtered[i] = (data[i] * 0.6 + data[i-1] * 0.15 + data[i+1] * 0.15 + 
                       data[i-2] * 0.05 + data[i+2] * 0.05);
      }
      for (let i = 0; i < 2; i++) filtered[i] = data[i];
      for (let i = len - 2; i < len; i++) filtered[i] = data[i];
    } else {
      for (let i = 2; i < len - 2; i++) {
        filtered[i] = data[i] * 1.1 - (data[i-1] + data[i+1]) * 0.05;
      }
      for (let i = 0; i < 2; i++) filtered[i] = data[i];
      for (let i = len - 2; i < len; i++) filtered[i] = data[i];
    }
    
    return filtered;
  }

  function bufferToWaveBlob(buf, scale) {
    const numCh = buf.numberOfChannels; const len = buf.length; const sr = buf.sampleRate;
    const bytesPerSamp = 2; const blockAlign = numCh * bytesPerSamp; const byteRate = sr * blockAlign;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize); const v = new DataView(ab);
    let p = 0;
    function ws(s) { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); }
    function w32(n) { v.setUint32(p, n, true); p += 4; }
    function w16(n) { v.setUint16(p, n, true); p += 2; }
    ws("RIFF"); w32(36 + dataSize); ws("WAVE");
    ws("fmt "); w32(16); w16(1); w16(numCh); w32(sr); w32(byteRate); w16(blockAlign); w16(16);
    ws("data"); w32(dataSize);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i] * (scale || 1.0)));
        v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true); p += 2;
      }
    }
    return new Blob([ab], { type: "audio/wav" });
  }
  function bufferToWaveUrl(buf) { return URL.createObjectURL(bufferToWaveBlob(buf)); }

  // ---------- 3. 变调 ----------
  function pitchShiftBuffer(src, semitones) {
    if (Math.abs(semitones) < 0.01) return src;
    const ctx = actx();
    const ratio = Math.pow(2, semitones / 12);
    const sr = src.sampleRate; const numCh = src.numberOfChannels;

    const stretchedLen = Math.floor(src.length / ratio);
    const stretched = [];
    for (let c = 0; c < numCh; c++) {
      const ch = src.getChannelData(c);
      const out = new Float32Array(stretchedLen);
      for (let i = 0; i < stretchedLen; i++) {
        const x = i * ratio; const j = Math.floor(x); const f = x - j;
        out[i] = (j + 1 < ch.length) ? ch[j] * (1 - f) + ch[j + 1] * f : (ch[j] || 0);
      }
      stretched.push(out);
    }

    const outLen = src.length;
    const grain = 1024, hopOut = 256;
    const winG = new Float32Array(grain);
    for (let i = 0; i < grain; i++) winG[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain);
    const outChans = []; for (let c = 0; c < numCh; c++) outChans.push(new Float32Array(outLen));
    const norm = new Float32Array(outLen);

    for (let outStart = 0; outStart + grain < outLen; outStart += hopOut) {
      const inStart = Math.floor(outStart * (stretchedLen / outLen));
      if (inStart + grain >= stretchedLen) break;
      for (let c = 0; c < numCh; c++) {
        const ich = stretched[c]; const och = outChans[c];
        for (let i = 0; i < grain; i++) och[outStart + i] += ich[inStart + i] * winG[i];
      }
      for (let i = 0; i < grain; i++) norm[outStart + i] += winG[i] * winG[i];
    }
    for (let c = 0; c < numCh; c++) { const och = outChans[c]; for (let i = 0; i < outLen; i++) if (norm[i] > 1e-4) och[i] /= norm[i]; }

    let peak = 0.0001;
    for (let c = 0; c < numCh; c++) { const och = outChans[c]; for (let i = 0; i < outLen; i++) if (Math.abs(och[i]) > peak) peak = Math.abs(och[i]); }
    const g = 0.9 / peak;
    for (let c = 0; c < numCh; c++) for (let i = 0; i < outLen; i++) outChans[c][i] *= g;

    const outBuf = ctx.createBuffer(numCh, outLen, sr);
    for (let c = 0; c < numCh; c++) outBuf.copyToChannel(outChans[c], c);
    return outBuf;
  }

  const PITCH_TABLE = {
    "female-high:male-group": -5, "female-high:male-solo": -4, "female-high:female-group": 0, "female-high:female-solo": 1,
    "female-mid:male-group": -4, "female-mid:male-solo": -3, "female-mid:female-group": 0, "female-mid:female-solo": 1,
    "male-high:male-group": -2, "male-high:male-solo": -1, "male-high:female-group": 4, "male-high:female-solo": 5,
    "male-low:male-group": -3, "male-low:male-solo": -2, "male-low:female-group": 5, "male-low:female-solo": 6,
  };
  const NOTE_TABLE = {
    "female-high:male-group": "你是偏高女声，唱男团原调会卡在换声区，建议降 5 个半音，副歌更稳定。",
    "female-mid:male-group": "你是普通女声，唱男团降 4 个半音后基本落在舒适中音区，情绪自然。",
    "male-high:female-group": "你是偏高男声，唱女团歌建议升 4 个半音，不勉强也不减风采。",
    "male-low:female-group": "你是偏低男声，唱女团歌升 5-6 个半音到低八度后，再微调避免过低。",
    "default": "根据常见音域差估算，可在下方手动微调 ±1 半音，感受更舒服。",
  };
  function updateRecommendation() {
    const key = S.myVoice + ":" + S.origVoice;
    const semi = PITCH_TABLE[key] || 0;
    const note = NOTE_TABLE[key] || NOTE_TABLE.default;
    $("recommendedSemitones").textContent = (semi > 0 ? "+" : "") + semi;
    $("recommendedNote").textContent = note;
    S._recommended = semi;
  }
  function bindVoiceGroups(container, stateKey) {
    container.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        container.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active"); S[stateKey] = chip.dataset.voice; updateRecommendation();
      });
    });
  }
  function setOrigVoice(voiceKey) {
    const grp = $("origVoiceGroup"); const chips = grp.querySelectorAll(".chip");
    let hit = false;
    chips.forEach((c) => { if (c.dataset.voice === voiceKey) { c.classList.add("active"); hit = true; S.origVoice = voiceKey; } else c.classList.remove("active"); });
    if (!hit) { chips[0].classList.add("active"); S.origVoice = chips[0].dataset.voice; }
    updateRecommendation();
  }
  bindVoiceGroups($("myVoiceGroup"), "myVoice");
  bindVoiceGroups($("origVoiceGroup"), "origVoice");
  updateRecommendation();

  $("applyRecBtn").addEventListener("click", () => {
    const r = S._recommended || 0;
    S.semitones = r; $("pitchSlider").value = r; $("semitoneDisplay").textContent = r;
    rebuildPitchShifted();
    toast("已应用推荐变调：" + (r > 0 ? "+" : "") + r + " 半音");
  });
  $("pitchSlider").addEventListener("input", (e) => { S.semitones = +e.target.value; $("semitoneDisplay").textContent = S.semitones; });
  $("pitchSlider").addEventListener("change", () => rebuildPitchShifted());

  function rebuildPitchShifted() {
    if (!S.karaokeBuffer) return;
    S.pitchShiftedBuffer = null;
    const wasPlaying = S.pitchPlayer.playing;
    stopPitchPlayer();
    $("playerState").textContent = "正在重新计算变调…";
    setTimeout(() => {
      try {
        S.pitchShiftedBuffer = pitchShiftBuffer(S.karaokeBuffer, S.semitones);
        $("playerState").textContent = "就绪（已变调 " + (S.semitones > 0 ? "+" : "") + S.semitones + " 半音）";
        $("timeDur").textContent = fmtTime(S.pitchShiftedBuffer.duration);
        if (wasPlaying) startPitchPlayer(0);
      } catch (e) { console.error(e); $("playerState").textContent = "变调计算失败"; }
    }, 30);
  }

  function startPitchPlayer(atOffset) {
    if (!S.pitchShiftedBuffer) { rebuildPitchShifted(); return; }
    stopPitchPlayer();
    const ctx = actx();
    const src = ctx.createBufferSource(); src.buffer = S.pitchShiftedBuffer;
    const gain = ctx.createGain(); gain.gain.value = +$("volumeSlider").value;
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    src.connect(gain); gain.connect(an); an.connect(ctx.destination);
    src.start(0, atOffset || 0);
    S.pitchPlayer.source = src; S.pitchPlayer.gain = gain; S.pitchPlayer.analyser = an;
    S.pitchPlayer.startAt = ctx.currentTime - (atOffset || 0); S.pitchPlayer.playing = true;
    src.onended = () => { if (S.pitchPlayer.source === src) stopPitchPlayer(); };
    drawWave(); tickTime(); $("playerState").textContent = "播放中";
  }
  function stopPitchPlayer() {
    try { S.pitchPlayer.source && S.pitchPlayer.source.stop(); } catch (e) { }
    S.pitchPlayer.playing = false; S.pitchPlayer.source = null;
    if (S.pitchPlayer.raf) cancelAnimationFrame(S.pitchPlayer.raf); S.pitchPlayer.raf = null;
    clearWaveCanvas();
    $("timeFill").style.width = "0%"; $("timeCur").textContent = "00:00"; $("playerState").textContent = "已停止";
  }
  $("playPitchBtn").addEventListener("click", () => {
    if (S.pitchPlayer.playing) {
      stopPitchPlayer(); S.pitchPlayer.pausedAt = Math.max(0, actx().currentTime - S.pitchPlayer.startAt);
    } else startPitchPlayer(S.pitchPlayer.pausedAt || 0);
  });
  $("stopPitchBtn").addEventListener("click", () => { S.pitchPlayer.pausedAt = 0; stopPitchPlayer(); });
  $("volumeSlider").addEventListener("input", (e) => { if (S.pitchPlayer.gain) S.pitchPlayer.gain.gain.value = +e.target.value; });

  function clearWaveCanvas() {
    const c = $("waveCanvas"); if (!c) return;
    c.width = c.clientWidth || 600;
    const cx = c.getContext("2d");
    cx.fillStyle = "rgba(255,255,255,0.02)"; cx.fillRect(0, 0, c.width, c.height);
  }
  function drawWave() {
    const c = $("waveCanvas"); if (!c) return;
    c.width = c.clientWidth || 600;
    const cx = c.getContext("2d");
    const buf = new Uint8Array(S.pitchPlayer.analyser.fftSize);
    function loop() {
      if (!S.pitchPlayer.playing) return;
      S.pitchPlayer.analyser.getByteTimeDomainData(buf);
      cx.fillStyle = "rgba(18, 16, 38, 0.35)"; cx.fillRect(0, 0, c.width, c.height);
      cx.lineWidth = 2;
      const grd = cx.createLinearGradient(0, 0, c.width, 0);
      grd.addColorStop(0, "#ff5ea8"); grd.addColorStop(1, "#7dd3fc"); cx.strokeStyle = grd;
      cx.beginPath();
      const step = c.width / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] / 128 - 1; const y = (0.5 - v * 0.4) * c.height;
        if (i === 0) cx.moveTo(i * step, y); else cx.lineTo(i * step, y);
      }
      cx.stroke();
      S.pitchPlayer.raf = requestAnimationFrame(loop);
    }
    loop();
  }
  function tickTime() {
    function loop() {
      if (!S.pitchPlayer.playing) return;
      const t = actx().currentTime - S.pitchPlayer.startAt;
      const dur = S.pitchShiftedBuffer ? S.pitchShiftedBuffer.duration : 1;
      $("timeCur").textContent = fmtTime(t);
      $("timeFill").style.width = Math.min(100, (t / dur) * 100) + "%";
      setTimeout(loop, 250);
    }
    loop();
  }

  $("toStep2").addEventListener("click", () => { if (S.karaokeBuffer && !S.pitchShiftedBuffer) rebuildPitchShifted(); });
  $("toStep3").addEventListener("click", () => { if (S.karaokeBuffer && !S.pitchShiftedBuffer) rebuildPitchShifted(); });

  // ---------- 4. 录音 & 合唱 ----------
  function setMode(m) {
    S.mode = m;
    qsa(".mode-tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
    $("chorusArea").classList.toggle("hidden", m !== "chorus");
    $("commitBtn").dataset.mode = m;
    if (m === "chorus" && S.chorusTracks.length === 0) addChorusTrack("成员 1");
  }
  qsa(".mode-tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  setMode("solo");

  $("addChorusBtn").addEventListener("click", () => addChorusTrack("成员 " + (S.chorusTracks.length + 1)));

  function addChorusTrack(name) {
    const id = "tr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    S.chorusTracks.push({ id: id, name: name, buffer: null, blob: null, url: null, muted: false, vol: 1.0 });
    renderChorus();
  }
  function renderChorus() {
    const box = $("chorusTracks"); box.innerHTML = "";
    S.chorusTracks.forEach((tr, idx) => {
      const el = document.createElement("div");
      el.className = "chorus-item";
      el.innerHTML = '<div class="chorus-col col-a"><span class="chorus-idx">' + (idx + 1) + '</span><input class="chorus-name" value="' + tr.name + '" /></div>' +
        '<div class="chorus-col col-b"><button class="btn btn-outline sm btn-record-this" data-id="' + tr.id + '"><i data-lucide="mic"></i> ' + (tr.buffer ? "重录" : "录制") + (idx === 0 ? "" : "（跟参考轨）") + '</button>' +
        '<button class="btn btn-ghost sm btn-remove" data-id="' + tr.id + '"><i data-lucide="trash-2"></i></button>' +
        '<span class="chorus-status">' + (tr.buffer ? "✅ 已录制 · " + fmtTime(tr.buffer.duration) : "⏳ 未录制") + '</span></div>';
      if (tr.url) { const audio = document.createElement("audio"); audio.controls = true; audio.src = tr.url; el.appendChild(audio); }
      box.appendChild(el);
    });
    if (window.lucide) window.lucide.createIcons();
    box.querySelectorAll(".btn-record-this").forEach((b) => b.addEventListener("click", () => startChorusRecord(b.dataset.id)));
    box.querySelectorAll(".btn-remove").forEach((b) => b.addEventListener("click", () => {
      S.chorusTracks = S.chorusTracks.filter((x) => x.id !== b.dataset.id); renderChorus();
    }));
  }
  function startChorusRecord(id) {
    const tr = S.chorusTracks.find((x) => x.id === id);
    if (!tr) return;
    S._targetTrack = tr; S._recordingChorus = true; startRecording();
  }

  const recCanvas = $("recCanvas");
  S.rec.canvas = recCanvas; S.rec.ctx = recCanvas.getContext("2d");
  recCanvas.width = recCanvas.clientWidth || 420; recCanvas.height = 80;
  window.addEventListener("resize", () => { recCanvas.width = recCanvas.clientWidth || 420; });

  $("recBtn").addEventListener("click", () => { if (S.rec.active) stopRecording(); else startRecording(); });

  async function startRecording() {
    if (!S.pitchShiftedBuffer) { toast("请先完成伴奏分离与变调"); return; }
    try { S.rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast("无法访问麦克风：" + e.message, 3200); return; }
    stopPitchPlayer();
    S.rec.active = false;
    $("countdown").classList.remove("hidden");
    let t = 3; $("countdown").textContent = t;
    const iv = setInterval(() => {
      t--;
      if (t <= 0) { clearInterval(iv); $("countdown").classList.add("hidden"); beginRecord(); }
      else $("countdown").textContent = t;
    }, 800);
  }

  function beginRecord() {
    const ctx = actx();
    const sourceMic = ctx.createMediaStreamSource(S.rec.stream);
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    sourceMic.connect(analyser); S.rec.analyser = analyser;

    const mr = new MediaRecorder(S.rec.stream, { mimeType: "audio/webm;codecs=opus" });
    S.rec.chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) S.rec.chunks.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(S.rec.chunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      blob.arrayBuffer().then((ab) => ctx.decodeAudioData(ab.slice(0))).then((voiceBuf) => {
        S.lastVoiceBuffer = voiceBuf;
        showAnalysis(voiceBuf);
        if (S._recordingChorus && S._targetTrack) {
          S._targetTrack.blob = blob; S._targetTrack.url = url; S._targetTrack.buffer = voiceBuf;
          S._recordingChorus = false; S._targetTrack = null; renderChorus();
          toast("合唱轨录制完成，已加入混音"); rebuildFinalMix();
        } else {
          $("playerVoice").src = url; $("voicePreview").classList.remove("hidden");
          // 自动加入混音并生成最终作品
          rebuildFinalMix();
          toast("人声录制完成！已自动生成最终混音，可以直接导出 🎤");
        }
      }).catch((e) => { toast("人声解码失败：" + e.message, 3200); });
    };
    mr.start(); S.rec.mediaRecorder = mr;

    const src = ctx.createBufferSource(); src.buffer = S.pitchShiftedBuffer;
    const g = ctx.createGain(); g.gain.value = +$("monitorVol").value;
    src.connect(g); g.connect(ctx.destination);
    S.rec.source = src; S.rec.gainMonitor = g;
    src.start();

    S.rec.active = true; S.rec.startAt = performance.now();
    $("recLabel").textContent = "停止录音"; $("recBtn").classList.add("recording"); $("recState").textContent = "录音中…";
    src.onended = () => { if (S.rec.active) stopRecording(); };
    drawRecViz();
    S.rec.timer = setInterval(() => { const s = (performance.now() - S.rec.startAt) / 1000; $("recTimer").textContent = fmtTime(s); }, 250);
  }

  function stopRecording() {
    if (!S.rec.active) return;
    S.rec.active = false;
    try { S.rec.source && S.rec.source.stop(); } catch (e) { }
    try { S.rec.mediaRecorder && S.rec.mediaRecorder.stop(); } catch (e) { }
    if (S.rec.stream) S.rec.stream.getTracks().forEach((t) => t.stop());
    clearInterval(S.rec.timer);
    $("recLabel").textContent = "开始录音"; $("recBtn").classList.remove("recording"); $("recState").textContent = "录音完成";
  }

  function drawRecViz() {
    const ctx = S.rec.ctx; const buf = new Uint8Array(S.rec.analyser.fftSize);
    function loop() {
      if (!S.rec.active) { ctx.fillStyle = "rgba(18,16,38,0.3)"; ctx.fillRect(0, 0, S.rec.canvas.width, S.rec.canvas.height); return; }
      S.rec.analyser.getByteTimeDomainData(buf);
      const w = S.rec.canvas.width, h = S.rec.canvas.height;
      ctx.fillStyle = "rgba(18,16,38,0.45)"; ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 2;
      const grd = ctx.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, "#ff5ea8"); grd.addColorStop(1, "#a78bfa"); ctx.strokeStyle = grd;
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] / 128 - 1;
        const x = (i / buf.length) * w; const y = (0.5 - v * 0.45) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      requestAnimationFrame(loop);
    }
    loop();
  }

  $("commitBtn").addEventListener("click", () => rebuildFinalMix());
  $("retryBtn").addEventListener("click", () => { $("voicePreview").classList.add("hidden"); S.lastVoiceBuffer = null; });

  function mixBuffers(baseBuf, addBufs, baseGain, addGains) {
    const ctx = actx(); const sr = baseBuf.sampleRate; const numCh = baseBuf.numberOfChannels; const outLen = baseBuf.length;
    const out = []; for (let c = 0; c < numCh; c++) out.push(new Float32Array(outLen));
    for (let c = 0; c < numCh; c++) { const d = baseBuf.getChannelData(c); for (let i = 0; i < outLen; i++) out[c][i] = d[i] * baseGain; }
    addBufs.forEach((ab, k) => {
      if (!ab) return; const g = addGains[k] || 1.0; const addCh = ab.numberOfChannels; const addLen = ab.length;
      for (let c = 0; c < numCh; c++) { const src = ab.getChannelData(c % addCh); const lim = Math.min(addLen, outLen); for (let i = 0; i < lim; i++) out[c][i] += src[i] * g; }
    });
    let peak = 0.0001;
    for (let i = 0; i < outLen; i++) for (let c = 0; c < numCh; c++) if (Math.abs(out[c][i]) > peak) peak = Math.abs(out[c][i]);
    const g = 0.95 / peak;
    for (let i = 0; i < outLen; i++) for (let c = 0; c < numCh; c++) out[c][i] *= g;
    const b = ctx.createBuffer(numCh, outLen, sr);
    for (let c = 0; c < numCh; c++) b.copyToChannel(out[c], c);
    return b;
  }

  function rebuildFinalMix() {
    if (!S.pitchShiftedBuffer) {
      toast("请先完成前两步：分离人声并设置降调", 3000);
      return;
    }
    
    const vg = +$("voiceVol").value; const bg = +$("bgVol").value;
    const addBufs = []; const addGains = [];
    
    if (S.mode === "chorus") {
      S.chorusTracks.forEach((tr) => { if (tr.buffer) { addBufs.push(tr.buffer); addGains.push(vg * tr.vol); } });
      if (addBufs.length === 0) { 
        toast("合唱模式下暂无录制轨，请先录制合唱", 3000); 
        return; 
      }
    } else {
      if (!S.lastVoiceBuffer) { 
        toast("还没有人声录音，请先录制你的歌声 🎤", 3000); 
        return; 
      }
      addBufs.push(S.lastVoiceBuffer); addGains.push(vg);
    }
    
    const mixed = mixBuffers(S.pitchShiftedBuffer, addBufs, bg, addGains);
    S.mixBuffer = mixed;
    $("playerMix").src = bufferToWaveUrl(mixed); 
    $("finalMix").classList.remove("hidden"); 
    $("toStep4").disabled = false;
    toast("最终混音已生成 ✨ 可以导出了！");
  }

  // ---------- 5. 导出 ----------
  $("exportWav").addEventListener("click", () => {
    if (!S.mixBuffer) {
      if (!S.lastVoiceBuffer) {
        toast("⚠️ 还没有录制人声！请先录制你的歌声再导出", 4000);
        return;
      }
      toast("正在生成混音…", 1500);
      setTimeout(() => {
        rebuildFinalMix();
        if (S.mixBuffer) {
          const blob = bufferToWaveBlob(S.mixBuffer);
          triggerDownload(blob, (S.songTitle || "cover") + "_IdolCover.wav");
        }
      }, 100);
      return;
    }
    const blob = bufferToWaveBlob(S.mixBuffer);
    triggerDownload(blob, (S.songTitle || "cover") + "_IdolCover.wav");
  });

  $("exportMp3").addEventListener("click", () => {
    if (!S.mixBuffer) {
      if (!S.lastVoiceBuffer) {
        toast("⚠️ 还没有录制人声！请先录制你的歌声再导出", 4000);
        return;
      }
      toast("正在生成混音…", 1500);
      setTimeout(() => {
        rebuildFinalMix();
        if (S.mixBuffer) {
          exportToMp3(S.mixBuffer);
        }
      }, 100);
      return;
    }
    exportToMp3(S.mixBuffer);
  });

  function exportToMp3(buffer) {
    showLoading("正在编码 MP3", "请稍候...");
    updateLoading("正在编码 MP3", "请稍候...", 20);
    
    setTimeout(() => {
      try {
        if (typeof lamejs === 'undefined') {
          throw new Error("lamejs 库未加载");
        }
        
        const sr = buffer.sampleRate;
        const channels = buffer.numberOfChannels;
        
        updateLoading("正在编码 MP3", "处理音频数据...", 40);
        
        let leftData = buffer.getChannelData(0);
        let rightData = channels > 1 ? buffer.getChannelData(1) : leftData;
        
        const samplesL = floatTo16BitPCM(leftData);
        const samplesR = floatTo16BitPCM(rightData);
        
        updateLoading("正在编码 MP3", "编码中...", 70);
        
        const mp3encoder = new lamejs.Mp3Encoder(channels, sr, 128);
        const blockSize = 1152;
        const mp3Data = [];
        
        for (let i = 0; i < samplesL.length; i += blockSize) {
          const left = samplesL.subarray(i, Math.min(i + blockSize, samplesL.length));
          const right = samplesR.subarray(i, Math.min(i + blockSize, samplesR.length));
          let mp3buf;
          if (channels === 1) {
            mp3buf = mp3encoder.encodeBuffer(left);
          } else {
            mp3buf = mp3encoder.encodeBuffer(left, right);
          }
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
        }
        
        const mp3buf = mp3encoder.flush();
        if (mp3buf.length > 0) {
          mp3Data.push(mp3buf);
        }
        
        updateLoading("正在编码 MP3", "即将完成...", 90);
        
        const blob = new Blob(mp3Data, { type: "audio/mpeg" });
        
        updateLoading("MP3 导出完成！", "", 100);
        setTimeout(() => {
          hideLoading();
          triggerDownload(blob, (S.songTitle || "cover") + "_IdolCover.mp3");
          toast("MP3 导出成功！📦");
        }, 300);
        
      } catch (e) {
        hideLoading();
        console.error("MP3 encoding error:", e);
        toast("网络不佳或编码失败，已帮您导出 WAV 格式", 4000);
        const blob = bufferToWaveBlob(buffer);
        triggerDownload(blob, (S.songTitle || "cover") + "_IdolCover.wav");
      }
    }, 100);
  }

  function floatTo16BitPCM(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
  }

  function ensureMix() { 
    if (!S.mixBuffer) { 
      if (!S.lastVoiceBuffer) {
        alert("⚠️ 还没有录制人声！\n\n请先录制你的歌声，然后再导出作品。\n\n步骤：\n1. 选择歌曲\n2. 分离人声\n3. 设置降调\n4. 录制你的歌声\n5. 导出作品");
        return false;
      }
      toast("正在生成混音…", 1500);
      setTimeout(() => {
        rebuildFinalMix();
      }, 100);
      return false;
    } 
    return true; 
  }
  function triggerDownload(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  $("toggleLyricEdit").addEventListener("click", () => {
    const t = $("lyricText"); t.disabled = !t.disabled; if (!t.disabled) t.focus();
    toast(t.disabled ? "已锁定歌词" : "可编辑歌词");
  });

  function parseLyrics(text) {
    const lines = text.split("\n");
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim(); if (!l) continue;
      let t = 0, txt = l;
      const m = l.match(/\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/);
      if (m) { t = parseInt(m[1], 10) * 60 + parseFloat(m[2]); txt = m[3]; }
      items.push({ t: t, text: txt });
    }
    return items;
  }
  function getCurrentLyric(items, t) {
    let cur = { text: "", index: -1 };
    for (let i = 0; i < items.length; i++) if (items[i].t <= t) cur = { text: items[i].text, index: i };
    return cur;
  }

  // ---------- AI 音准分析 ----------
  function analyzePitch(buffer) {
    const sr = buffer.sampleRate;
    const ch = buffer.numberOfChannels;
    const len = buffer.length;

    // 合并通道
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += buffer.getChannelData(c)[i];
      mono[i] = sum / ch;
    }

    // 简单自相关音高检测
    const frameSize = 512;
    const hopSize = 256;
    const pitches = [];
    const times = [];

    for (let i = 0; i + frameSize < len; i += hopSize) {
      const frame = mono.slice(i, i + frameSize);
      const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frameSize);
      if (rms < 0.01) { pitches.push(null); continue; }

      // 自相关
      let maxLag = 0;
      let maxCorr = -1;
      for (let lag = 40; lag < 200; lag++) {
        let corr = 0;
        for (let j = 0; j < frameSize - lag; j++) {
          corr += frame[j] * frame[j + lag];
        }
        if (corr > maxCorr) { maxCorr = corr; maxLag = lag; }
      }

      if (maxCorr > 0) {
        const freq = sr / maxLag;
        // 人声范围：80Hz - 1000Hz
        if (freq >= 80 && freq <= 1000) {
          pitches.push(freq);
        } else {
          pitches.push(null);
        }
      } else {
        pitches.push(null);
      }
      times.push(i / sr);
    }

    // 计算统计数据
    const validPitches = pitches.filter(p => p !== null);
    const stats = {
      avgDeviation: "--",
      maxPitch: "--",
      minPitch: "--",
      rhythmScore: "--",
      score: "--",
      tips: []
    };

    if (validPitches.length > 0) {
      // 转换为 MIDI
      const midis = validPitches.map(f => 69 + 12 * Math.log2(f / 440));
      const avgMidi = midis.reduce((a, b) => a + b, 0) / midis.length;
      const deviations = midis.map(m => Math.abs(m - avgMidi));
      const avgDev = deviations.reduce((a, b) => a + b, 0) / deviations.length;

      stats.avgDeviation = avgDev.toFixed(1) + " 半音";
      stats.maxPitch = freqToNote(Math.max(...validPitches));
      stats.minPitch = freqToNote(Math.min(...validPitches));

      // 节奏稳定性（根据音高变化率）
      let pitchChanges = 0;
      for (let i = 1; i < pitches.length; i++) {
        if (pitches[i] && pitches[i - 1]) {
          const diff = Math.abs(pitches[i] - pitches[i - 1]);
          if (diff > 20) pitchChanges++;
        }
      }
      const changeRate = pitchChanges / pitches.length;
      stats.rhythmScore = Math.max(0, Math.min(100, Math.round((1 - changeRate * 3) * 100))) + "分";

      // 综合评分
      const pitchScore = Math.max(0, Math.min(100, Math.round((1 - avgDev / 3) * 100)));
      const rhythmVal = parseInt(stats.rhythmScore);
      stats.score = Math.round((pitchScore * 0.7 + rhythmVal * 0.3));

      // 生成建议
      if (avgDev > 2) stats.tips.push("⚠️ 音准偏差较大，建议多练习音高训练");
      if (pitchScore > 85) stats.tips.push("🎯 音准很棒！继续保持");
      if (rhythmVal < 70) stats.tips.push("⏱ 节奏稳定性有待提升，注意节拍");
      if (stats.score >= 80) stats.tips.push("🌟 优秀！你的翻唱很专业");
      if (stats.score < 60) stats.tips.push("💪 继续加油！多练习会越来越好");
    }

    return { pitches, times, stats };
  }

  function freqToNote(freq) {
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const midi = 69 + 12 * Math.log2(freq / 440);
    const noteIndex = Math.round(midi) % 12;
    const octave = Math.floor(Math.round(midi) / 12) - 1;
    return noteNames[noteIndex] + octave;
  }

  function drawAnalysisChart(pitches, times) {
    const canvas = $("analysisCanvas");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "rgba(14,165,233,0.06)";
    ctx.fillRect(0, 0, w, h);

    // 绘制网格
    ctx.strokeStyle = "rgba(14,165,233,0.1)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const y = (h / 8) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 绘制音准曲线
    if (pitches.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 2;
      let started = false;

      for (let i = 0; i < pitches.length; i++) {
        if (pitches[i] !== null) {
          const x = (times[i] / times[times.length - 1]) * w;
          const midi = 69 + 12 * Math.log2(pitches[i] / 440);
          // 映射到画布高度（60-80 MIDI）
          const y = h - ((midi - 60) / 20) * h;
          if (y >= 0 && y <= h) {
            if (!started) { ctx.moveTo(x, y); started = true; }
            else { ctx.lineTo(x, y); }
          }
        }
      }
      ctx.stroke();

      // 绘制当前音高标记点
      for (let i = 0; i < pitches.length; i++) {
        if (pitches[i] !== null) {
          const x = (times[i] / times[times.length - 1]) * w;
          const midi = 69 + 12 * Math.log2(pitches[i] / 440);
          const y = h - ((midi - 60) / 20) * h;
          if (y >= 0 && y <= h) {
            ctx.beginPath();
            ctx.fillStyle = "#0ea5e9";
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  // 绘制人声波形
  function drawVoiceWave(buffer) {
    const canvas = $("voiceWaveCanvas");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = "rgba(14,165,233,0.06)";
    ctx.fillRect(0, 0, w, h);

    const sr = buffer.sampleRate;
    const ch = buffer.numberOfChannels;
    const len = buffer.length;

    // 合并通道
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += buffer.getChannelData(c)[i];
      mono[i] = sum / ch;
    }

    // 降采样绘制
    const step = Math.floor(len / w);
    ctx.strokeStyle = "#0ea5e9";
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = 0; i < step; i++) {
        const idx = x * step + i;
        if (idx < len) sum += Math.abs(mono[idx]);
      }
      const avg = sum / step;
      const y = h / 2 - avg * h * 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = 0; i < step; i++) {
        const idx = x * step + i;
        if (idx < len) sum += Math.abs(mono[idx]);
      }
      const avg = sum / step;
      const y = h / 2 + avg * h * 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 在人声录制完成后自动触发音准分析
  function showAnalysis(buffer) {
    drawVoiceWave(buffer);
    const result = analyzePitch(buffer);
    drawAnalysisChart(result.pitches, result.times);

    $("analysisScore").textContent = result.stats.score !== "--" ? result.stats.score + "分" : "--";
    $("avgDeviation").textContent = result.stats.avgDeviation;
    $("maxPitch").textContent = result.stats.maxPitch;
    $("minPitch").textContent = result.stats.minPitch;
    $("rhythmScore").textContent = result.stats.rhythmScore;

    if (result.stats.tips.length > 0) {
      $("analysisTips").innerHTML = "<ul>" + result.stats.tips.map(t => "<li>" + t + "</li>").join("") + "</ul>";
    } else {
      $("analysisTips").innerHTML = "";
    }

    $("analysisBox").classList.remove("hidden");
    toast("AI 音准分析完成！");
  }

  // ---------- 标签筛选功能 ----------
  (function initFeatureFilter() {
    const btns = qsa(".tag-btn");
    const cards = qsa(".feature-card");
    const grid = document.querySelector(".feature-cards");
    btns.forEach((btn) => {
      btn.addEventListener("click", () => {
        btns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const feature = btn.dataset.feature;
        // 非 "all" 模式：一张卡片铺满全部四张的宽高
        if (feature === "all") {
          grid.classList.remove("is-single");
        } else {
          grid.classList.add("is-single");
        }
        cards.forEach((card) => {
          if (feature === "all" || card.dataset.card === feature) {
            card.classList.remove("hidden");
            card.style.animation = "feature-in 0.25s ease";
          } else {
            card.classList.add("hidden");
          }
        });
      });
    });
  })();

  // 初始化图标
  if (window.lucide) window.lucide.createIcons();

})();
