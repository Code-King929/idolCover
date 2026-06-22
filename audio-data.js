// 音频 Base64 数据文件
// 预置测试歌曲的音频数据

const AUDIO_DATA = {
  "male-group": {
    title: "Excitant",
    artist: "庞鹏洋",
    hint: "男团风，建议女声降 4-6 半音",
    // 音频数据会在需要时动态加载
    _loading: false,
    _data: null
  },
  "male-solo": {
    title: "漂洋过海来看你",
    artist: "周深",
    hint: "男中音独唱，建议女声降调",
    _loading: false,
    _data: null
  },
  "female-solo": {
    title: "唐人",
    artist: "董沐曦",
    hint: "古风女声，建议男声升调",
    _loading: false,
    _data: null
  },
  "female-group": {
    title: "小幸运",
    artist: "桃子鱼仔的Ukulele",
    hint: "清新女声，建议男声升 4-5 半音",
    _loading: false,
    _data: null
  }
};

// 动态加载音频 Base64 数据
async function loadAudioData(key) {
  if (AUDIO_DATA[key]._data) {
    return AUDIO_DATA[key]._data;
  }

  if (AUDIO_DATA[key]._loading) {
    // 等待加载完成
    while (AUDIO_DATA[key]._loading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return AUDIO_DATA[key]._data;
  }

  AUDIO_DATA[key]._loading = true;

  try {
    // 根据 key 确定文件名
    const fileMap = {
      "male-group": "excitant_base64.txt",
      "male-solo": "beyond_the_sea_base64.txt",
      "female-solo": "tang_people_base64.txt",
      "female-group": "lucky_star_base64.txt"
    };

    const response = await fetch("audio/" + fileMap[key]);
    if (!response.ok) {
      throw new Error("加载音频数据失败");
    }

    const base64Data = await response.text();
    AUDIO_DATA[key]._data = base64Data;
    return base64Data;
  } catch (error) {
    console.error("loadAudioData error:", error);
    throw error;
  } finally {
    AUDIO_DATA[key]._loading = false;
  }
}
