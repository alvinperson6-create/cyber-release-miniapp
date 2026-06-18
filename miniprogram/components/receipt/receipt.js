// 赛博放生局 · 收据组件
const { CREATURES, WATERS } = require('../../utils/data.js');

Component({
  properties: {
    show: { type: Boolean, value: false },
    receipt: { type: Object, value: null }
  },
  data: {
    shareClicked: false
  },
  observers: {
    show(val) {
      // 显示时重置分享按钮状态
      if (val) {
        this.setData({ shareClicked: false });
      }
    }
  },
  methods: {
    // 点击遮罩层关闭
    onOverlayTap(e) {
      if (e.target.dataset.role === 'overlay') {
        this.triggerEvent('close');
      }
    },
    // 分享按钮
    onShareTap() {
      this.setData({ shareClicked: true });
      const that = this;
      setTimeout(() => {
        that.setData({ shareClicked: false });
      }, 1500);
    },
    // 再来一只
    onAgainTap() {
      this.triggerEvent('close');
    },
    // 阻止冒泡
    noop() {}
  }
});
