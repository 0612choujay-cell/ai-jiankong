<template>
  <div class="journal" :class="{ embedded }" :role="embedded ? 'region' : 'dialog'" aria-label="日曆">
    <header class="bar">
      <button type="button" aria-label="上個月" @click="shift(-1)">‹</button>
      <h2>{{ year }} 年 {{ month + 1 }} 月</h2>
      <button type="button" aria-label="下個月" @click="shift(1)">›</button>
      <button v-if="!embedded" type="button" class="close" @click="$emit('close')">關閉</button>
    </header>

    <div class="grid">
      <span v-for="w in WEEK" :key="w" class="wd">{{ w }}</span>
      <span v-for="n in lead" :key="'b' + n" />
      <button
        v-for="d in daysInMonth" :key="d" type="button" class="day"
        :class="{ has: byDate[key(d)], on: selected === key(d) }"
        @click="pick(key(d))"
      >
        <b>{{ d }}</b>
        <span v-for="e in (byDate[key(d)] ?? []).slice(0, 2)" :key="e.id" class="tag">{{ e.label }}</span>
        <i v-if="byDate[key(d)]?.length > 2">+{{ byDate[key(d)].length - 2 }}</i>
      </button>
    </div>

    <p v-if="error" class="note">讀不到日曆</p>
    <p v-else-if="!entries.length" class="note">還沒有紀錄</p>

    <section v-if="selected && !openEntry" class="list">
      <h3>{{ selected }}</h3>
      <p v-if="!(byDate[selected] ?? []).length" class="note">這天沒有紀錄</p>
      <button v-for="e in byDate[selected] ?? []" :key="e.id" type="button" class="item" @click="openEntry = e">
        <span class="what">{{ e.label }}</span>
        <span class="when">{{ time(e.at) }}</span>
      </button>
    </section>

    <section v-if="openEntry" class="detail">
      <button type="button" class="back" @click="openEntry = null">‹ 回到這天</button>
      <h3>{{ openEntry.label }}</h3>
      <p class="when">{{ selected }} {{ time(openEntry.at) }}</p>
      <p v-if="openEntry.resultText" class="result">{{ openEntry.resultText }}</p>
      <p v-if="openEntry.headline">{{ openEntry.headline }}</p>
      <p v-if="openEntry.nextGoal">{{ openEntry.nextGoal }}</p>
      <img v-if="openEntry.photo" :src="openEntry.photo" alt="成果照片" class="big">
      <p v-if="openEntry.finished === true" class="result">✅ 都寫完了</p>
      <p v-else-if="openEntry.finished === false" class="result">還沒寫完<span v-if="openEntry.aiReason">：{{ openEntry.aiReason }}</span></p>

      <template v-if="openEntry.improvements?.length">
        <h4>怎麼改進</h4>
        <article v-for="(it, i) in openEntry.improvements" :key="i" class="box">
          <b>{{ it.label }}<span v-if="it.count"> · {{ it.count }} 次</span></b>
          <p>{{ it.why }}</p>
          <ul><li v-for="(t, j) in it.tips" :key="j">{{ t }}</li></ul>
        </article>
      </template>
      <template v-if="openEntry.events?.length">
        <h4>這次發生的事</h4>
        <ul><li v-for="(t, i) in openEntry.events" :key="i">{{ t }}</li></ul>
      </template>
      <template v-if="openEntry.axes?.length">
        <h4>五項表現</h4>
        <ul><li v-for="a in openEntry.axes" :key="a.label">{{ a.label }}：{{ a.value }}%</li></ul>
      </template>
      <button type="button" class="del" @click="remove(openEntry.id)">刪除這筆</button>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { listEntries, deleteEntry, localDateKey } from '../core/journalStore.js'

const props = defineProps({
  embedded: { type: Boolean, default: false },
  version: { type: Number, default: 0 },
})
defineEmits(['close'])

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth())
const entries = ref([])
const error = ref(false)
const selected = ref(localDateKey(now.getTime()))
const openEntry = ref(null)

const byDate = computed(() => {
  const m = {}
  for (const e of entries.value) (m[e.date] ??= []).push(e)
  return m
})
const daysInMonth = computed(() => new Date(year.value, month.value + 1, 0).getDate())
const lead = computed(() => new Date(year.value, month.value, 1).getDay())
const key = (d) => `${year.value}-${String(month.value + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const time = (ms) => new Date(ms).toTimeString().slice(0, 5)

function pick(k) { selected.value = k; openEntry.value = null }
function shift(delta) {
  const d = new Date(year.value, month.value + delta, 1)
  year.value = d.getFullYear()
  month.value = d.getMonth()
}
async function load() {
  try { entries.value = await listEntries(); error.value = false } catch { error.value = true }
}
async function remove(id) {
  try { await deleteEntry(id) } catch { /* 刪不掉就維持原樣 */ }
  openEntry.value = null
  await load()
}
onMounted(load)
watch(() => props.version, load)
</script>

<style scoped>
.journal { position: fixed; inset: 0; z-index: 50; overflow-y: auto; padding: 16px; background: var(--c-bg); color: var(--c-text); }
.bar { display: flex; align-items: center; gap: 12px; justify-content: center; margin-bottom: 12px; }
.bar h2 { margin: 0; min-width: 8em; text-align: center; }
.bar button { min-height: var(--tap-min); min-width: var(--tap-min); font-size: 24px; }
.bar .close { margin-left: 16px; font-size: var(--fs-body); padding: 0 16px; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; max-width: 46em; margin: 0 auto; }
.wd { text-align: center; color: var(--c-text-dim); }
.day { position: relative; aspect-ratio: 1; padding: 4px; border-radius: 10px; overflow: hidden; background: var(--c-surface); display: flex; flex-direction: column; align-items: flex-start; }
.day b { position: relative; z-index: 1; }
.day i { position: absolute; right: 4px; bottom: 2px; z-index: 1; font-style: normal; font-weight: 700; }
.day.on { outline: 3px solid currentColor; }
.note { text-align: center; color: var(--c-text-dim); }
.list { max-width: 46em; margin: 16px auto; }
.list article { display: flex; gap: 12px; margin: 12px 0; padding: 12px; background: var(--c-surface); border-radius: 12px; }
.list img { width: 45%; max-height: 40vh; object-fit: contain; border-radius: 8px; }
.what { margin: 0 0 4px; font-weight: 700; }
.when { margin: 0 0 8px; color: var(--c-text-dim); }
.journal.embedded { position: static; z-index: auto; overflow: visible; padding: 0; background: transparent; margin: 16px auto; max-width: 46em; }
.tag { position: relative; z-index: 1; font-size: 12px; line-height: 1.15; text-align: left; overflow: hidden; max-height: 2.3em; word-break: break-all; }
.item { display: flex; justify-content: space-between; width: 100%; min-height: var(--tap-min); padding: 8px 16px; margin: 8px 0; border-radius: 12px; background: var(--c-surface); text-align: left; }
.detail { max-width: 46em; margin: 16px auto; padding: 12px 16px; background: var(--c-surface); border-radius: 12px; }
.detail .big { display: block; max-width: 100%; max-height: 60vh; margin: 12px auto; border-radius: 8px; }
.detail .result { font-weight: 700; }
.detail .box { margin: 8px 0; }
.back, .del { min-height: var(--tap-min); padding: 0 16px; }
</style>
