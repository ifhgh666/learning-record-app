<script setup>
/**
 * 单张块卡片：标题 + 分类切换 + 标签输入 + 富文本正文。
 *
 * 设计取舍：标签用「输入后回车/逗号确认」的 chips 交互，而不是一个逗号分隔的
 * 文本框——因为标签是这个系统里唯一的自由维度，输入体验直接决定你会不会用。
 */
import { ref, computed } from 'vue'
import MarkdownEditor from './MarkdownEditor.vue'
import { CATEGORY_LABEL, CATEGORY_HINT } from '../api.js'

const props = defineProps({
  block: { type: Object, required: true },
  index: { type: Number, required: true },
  total: { type: Number, required: true },
  readonly: { type: Boolean, default: false },
})
const emit = defineEmits(['update', 'remove', 'move'])

const tagDraft = ref('')

/** 直接改 props.block 的字段并上抛，父组件负责持久化。 */
function patch(field, value) {
  emit('update', { ...props.block, [field]: value })
}

function commitTag() {
  const raw = tagDraft.value.trim()
  if (!raw) return
  const next = [...props.block.tags]
  for (const piece of raw.split(/[,，]/)) {
    const tag = piece.trim().replace(/^#+/, '')
    if (tag && !next.some((t) => t.toLowerCase() === tag.toLowerCase()) && next.length < 20) {
      next.push(tag.slice(0, 24))
    }
  }
  tagDraft.value = ''
  patch('tags', next)
}

function removeTag(tag) {
  patch('tags', props.block.tags.filter((t) => t !== tag))
}

/** 退格键在空输入时删掉最后一个标签（常见的 chips 交互） */
function onTagBackspace() {
  if (tagDraft.value === '' && props.block.tags.length) {
    patch('tags', props.block.tags.slice(0, -1))
  }
}

const categoryHint = computed(() => CATEGORY_HINT[props.block.category] ?? '')
</script>

<template>
  <article class="block-card card">
    <header class="block-head">
      <span class="block-index tiny muted">第 {{ index + 1 }} 块</span>

      <div class="cat-switch" role="group" aria-label="分类">
        <button
          v-for="(label, key) in CATEGORY_LABEL"
          :key="key"
          type="button"
          class="cat-btn"
          :class="[`cat-${key}`, { 'cat-active': block.category === key }]"
          :title="CATEGORY_HINT[key]"
          :disabled="readonly"
          @click="patch('category', key)"
        >
          {{ label }}
        </button>
      </div>

      <div class="block-ops">
        <button type="button" class="btn btn-ghost tiny" :disabled="readonly || index === 0" title="上移" @click="emit('move', index, -1)">↑</button>
        <button type="button" class="btn btn-ghost tiny" :disabled="readonly || index === total - 1" title="下移" @click="emit('move', index, 1)">↓</button>
        <button type="button" class="btn btn-ghost btn-danger tiny" :disabled="readonly" title="删除这块" @click="emit('remove', index)">删除</button>
      </div>
    </header>

    <input
      class="block-title"
      type="text"
      :value="block.title"
      :disabled="readonly"
      :placeholder="`这块学的是什么？例如「${block.category === 'memory' ? '背 30 个单词' : '理解了 self-attention'}」`"
      @input="patch('title', $event.target.value)"
    />

    <div class="tag-row">
      <span
        v-for="tag in block.tags"
        :key="tag"
        class="tag-chip"
      >
        #{{ tag }}
        <button v-if="!readonly" type="button" class="tag-x" title="移除标签" @click="removeTag(tag)">×</button>
      </span>
      <input
        v-if="!readonly"
        v-model="tagDraft"
        class="tag-input"
        type="text"
        placeholder="加标签，回车确认"
        @keydown.enter.prevent="commitTag"
        @keydown.,.prevent="commitTag"
        @keydown.backspace="onTagBackspace"
        @blur="commitTag"
      />
    </div>

    <MarkdownEditor
      :key="block.id"
      :model-value="block.content"
      :readonly="readonly"
      @update:model-value="patch('content', $event)"
    />

    <p v-if="!readonly" class="cat-hint tiny muted">{{ categoryHint }}</p>
  </article>
</template>

<style scoped>
.block-card { padding: 14px 16px 10px; }
.block-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.block-index { flex: none; }
.cat-switch {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.cat-btn {
  border: none;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}
.cat-btn + .cat-btn { border-left: 1px solid var(--line); }
.cat-btn:disabled { cursor: default; opacity: 0.85; }
.cat-memory.cat-active { background: var(--memory-soft); color: var(--memory); font-weight: 600; }
.cat-writing.cat-active { background: var(--writing-soft); color: var(--writing); font-weight: 600; }
.block-ops { margin-left: auto; display: flex; gap: 2px; }

.block-title {
  width: 100%;
  border: none;
  border-bottom: 1px dashed transparent;
  background: transparent;
  font-size: 17px;
  font-weight: 620;
  padding: 4px 0;
  outline: none;
  color: var(--text);
}
.block-title::placeholder { color: #b6bcc7; font-weight: 400; }
.block-title:hover { border-bottom-color: var(--line); }
.block-title:focus { border-bottom-color: var(--accent); }

.tag-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 4px;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.tag-x {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 1px;
  opacity: 0.6;
}
.tag-x:hover { opacity: 1; }
.tag-input {
  border: none;
  background: transparent;
  outline: none;
  font-size: 12px;
  min-width: 140px;
  padding: 2px 4px;
  color: var(--text);
}
.cat-hint { margin: 6px 0 0; }
</style>
