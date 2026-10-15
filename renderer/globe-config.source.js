// 赛博放生 · 地球配置的单一数据源
//
// 迁自 miniprogram/utils/globe-config.js（原小程序端数据源）。
// 网页端 3D 地球由此生成：node scripts/sync-globe-config.js
// 本文件只含数据与坐标换算，不含业务逻辑。

module.exports = {
  WATERS_GEO: {
    "pacific": {
      "name": "太平洋",
      "type": "ocean",
      "lat": 0,
      "lng": -160
    },
    "atlantic": {
      "name": "大西洋",
      "type": "ocean",
      "lat": 15,
      "lng": -40
    },
    "indian": {
      "name": "印度洋",
      "type": "ocean",
      "lat": -25,
      "lng": 75
    },
    "arctic": {
      "name": "北冰洋",
      "type": "ocean",
      "lat": 85,
      "lng": 0
    },
    "aegean": {
      "name": "爱琴海",
      "type": "ocean",
      "lat": 38,
      "lng": 25
    },
    "galapagos": {
      "name": "加拉帕戈斯",
      "type": "ocean",
      "lat": -0.7,
      "lng": -90.5
    },
    "baikal": {
      "name": "贝加尔湖",
      "type": "lake",
      "lat": 53.5,
      "lng": 108
    },
    "ness": {
      "name": "尼斯湖",
      "type": "lake",
      "lat": 57.3,
      "lng": -4.4
    },
    "xihu": {
      "name": "西湖",
      "type": "lake",
      "lat": 30.2,
      "lng": 120.1
    },
    "deadsea": {
      "name": "死海",
      "type": "lake",
      "lat": 31.5,
      "lng": 35.5
    },
    "xiang": {
      "name": "湘江",
      "type": "river",
      "lat": 28,
      "lng": 113
    },
    "mariana": {
      "name": "马里亚纳海沟",
      "type": "trench",
      "lat": 11.3,
      "lng": 142.2
    }
  },
  CREATURE_3D: {
    "koi": {
      "color": 15564123,
      "glow": 16757642,
      "name": "锦鲤"
    },
    "turtle": {
      "color": 8369828,
      "glow": 11129541,
      "name": "乌龟"
    },
    "cloud": {
      "color": 15787728,
      "glow": 16777215,
      "name": "云朵"
    }
  },
  GLOBE_ANIM: {
    "CHARGE_MIN_MS": 600,
    "DIVE_MS": 1600,
    "RIPPLE_MS": 2400,
    "BUBBLE_COUNT": 40,
    "FOCUS_MS": 900,
    "AUTO_ROTATE_SPEED": 0.0004
  }
};
