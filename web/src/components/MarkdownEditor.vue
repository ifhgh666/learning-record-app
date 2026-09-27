<script setup>
/**
 * Markdown 编辑器包装：Milkdown Crepe（所见即所得，底层 Markdown）。
 *
 * 两个关键约束：
 *  1. Crepe 内部异步初始化，组件可能在 ready 之前就被卸载（用户快速切 Tab）。
 *     用 alive/dispose 双 guard，否则会报 "editor is not ready" 并泄漏实例。
 *  2. 切换日期/块的"换内容"不由这里监听处理——父组件用 :key 强制重建组件。
 *     watch 一个富文本编辑器去替换全文既不可靠也容易和用户输入打架。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  placeholder: { type: String, default: '今天学到了什么？' },
})
const emit = defineEmits(['update:modelValue'])

const host = ref(null)
const status = ref('loading') // loading | ready | error
const errorMessage = ref('')

let instance = null
let alive = true

onMounted(async () => {
  try {
    const [{ Crepe }, { listener, listenerCtx }, { editorViewCtx }] = await Promise.all([
      import('@milkdown/crepe'),
      import('@milkdown/kit/plugin/listener'),
      import('@milkdown/kit/core'),
    ])
    await import('@milkdown/crepe/theme/common/style.css')
    await import('@milkdown/crepe/theme/frame.css')

    if (!alive || !host.value) return

    const crepe = new Crepe({
      root: host.value,
      defaultValue: props.modelValue || '',
      feature: {
        // 需求确认：代码块（高亮）与表格必须；公式、图片明确不要。
        [Crepe.Feature.CodeMirror]: true,
        [Crepe.Feature.Table]: true,
        [Crepe.Feature.LinkTooltip]: true,
        [Crepe.Feature.ListItem]: true,
        [Crepe.Feature.BlockEdit]: !props.readonly,
        [Crepe.Feature.Toolbar]: !props.readonly,
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.Latex]: false,
      },
    })

    crepe.editor.use(listener)
    crepe.editor.config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (!alive) return
        emit('update:modelValue', markdown)
      })
    })

    await crepe.create()

    if (!alive) {
      // 卸载发生在 create 期间：立刻销毁，不留僵尸实例
      try { await crepe.destroy() } catch { /* 忽略 */ }
      return
    }
    instance = crepe
    if (props.readonly) {
      const view = crepe.editor.ctx.get(editorViewCtx)
      view.setProps({ editable: () => false })
    }
    status.value = 'ready'
  } catch (err) {
    status.value = 'error'
    errorMessage.value = err?.message ?? String(err)
    console.error('[editor] Milkdown 初始化失败：', err)
  }
})

onBeforeUnmount(() => {
  alive = false
  const dying = instance
  instance = null
  if (dying) {
    Promise.resolve()
      .then(() => dying.destroy())
      .catch(() => { /* 忽略销毁错误 */ })
  }
})
</script>

<template>
  <div class="editor-shell">
    <div v-if="status === 'loading'" class="editor-state">编辑器加载中…</div>
    <div v-else-if="status === 'error'" class="editor-state editor-state-error">
      <strong>编辑器加载失败</strong>
      <p class="editor-error-msg">{{ errorMessage }}</p>
      <p class="editor-state-hint">你输入的文字没有丢失——把这段报错发给我，我来修。</p>
    </div>
    <div ref="host" class="editor-host" :class="{ 'editor-host-hidden': status !== 'ready' }" />
  </div>
</template>

<style scoped>
.editor-shell {
  position: relative;
  min-height: 120px;
}
.editor-state {
  padding: 18px 20px;
  color: #6b7280;
  font-size: 14px;
  border: 1px dashed #d8dbe2;
  border-radius: 8px;
  background: #fafbfc;
}
.editor-state-error {
  border-color: #f0a6a6;
  background: #fff6f6;
  color: #a13b3b;
}
.editor-error-msg {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
  margin: 6px 0;
}
.editor-state-hint {
  margin: 6px 0 0;
  font-size: 13px;
  color: #8a6a6a;
}
.editor-host-hidden {
  display: none;
}
</style>
