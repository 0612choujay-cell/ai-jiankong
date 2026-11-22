<template>
  <div class="journal" role="dialog" aria-label="日曆">
    <header class="bar">
      <button type="button" aria-label="上個月" @click="shift(-1)">‹</button>
      <h2>{{ year }} 年 {{ month + 1 }} 月</h2>
      <button type="button" aria-label="下個月" @click="shift(1)">›</button>
      <button type="button" class="close" @click="$emit('close')">關閉</button>
    </header>

    <div class="grid">
      <span v-for="w in WEEK" :key="w" class="wd">{{ w }}</span>
      <span v-for="n in lead" :key="'b' + n" />
      <button
        v-for="d in daysInMonth" :key="d" type="button" class="day"
        :class="{ has: byDate[key(d)], on: selected === key(d) }"
        @click="selected = key(d)"
      >
        <b>{{ d }}</b>
        <img v-if="byDate[key(d)]" :src="byDate[key(d)][0].photo" alt="">
        <i v-if="byDate[key(d)]?.length > 1">{{ byDate[key(d)].length }}</i>
      </button>
    </div>

    <p v-if="error" class="note">讀不到日曆</p>
    <p v-else-if="!entries.length" class="note">還沒有紀錄</p>

    <section v-if="selected" class="list">
      <h3>{{ selected }}</h3>
      <p v-if="!(byDate[selected] ?? []).length" class="note">這天沒有紀錄</p>
      <article v-for="e in byDate[selected] ?? []" :key="e.id">
        <img :src="e.photo" alt="成果照片">
        <div>
          <p class="what">{{ e.label }}</p>
          <p class="when">{{ time(e.at) }}<span v-if="e.finished === true"> · ✅ 寫完了</span><span v-else-if="e.finished === false"> · 還沒寫完</span></p>
          <button type="button" @click="remove(e.id)">刪除</button>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { listEntries, deleteEntry, localDateKey } from '../core/journalStore.js'

defineEmits(['close'])

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const now = new Date()
const year = ref(now.getFullYear())
const month = ref(now.getMonth())
const entries = ref([])
const error = ref(false)
const selected = ref(localDateKey(now.getTime()))

const byDate = computed(() => {
  const m = {}
  for (const e of entries.value) (m[e.date] ??= []).push(e)
  return m
})
const daysInMonth = computed(() => new Date(year.value, month.value + 1, 0).getDate())
const lead = computed(() => new Date(year.value, month.value, 1).getDay())
const key = (d) => `${year.value}-${String(month.value + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const time = (ms) => new Date(ms).toTimeString().slice(0, 5)

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
  await load()
}
onMounted(load)
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
.day img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .55; }
.day i { position: absolute; right: 4px; bottom: 2px; z-index: 1; font-style: normal; font-weight: 700; }
.day.on { outline: 3px solid currentColor; }
.note { text-align: center; color: var(--c-text-dim); }
.list { max-width: 46em; margin: 16px auto; }
.list article { display: flex; gap: 12px; margin: 12px 0; padding: 12px; background: var(--c-surface); border-radius: 12px; }
.list img { width: 45%; max-height: 40vh; object-fit: contain; border-radius: 8px; }
.what { margin: 0 0 4px; font-weight: 700; }
.when { margin: 0 0 8px; color: var(--c-text-dim); }
</style>
