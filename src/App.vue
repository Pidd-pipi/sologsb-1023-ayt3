<script setup lang="ts">
import { computed, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentRow, DifferenceStatus } from './types';

const {
  versions,
  leftVersionId,
  rightVersionId,
  rows,
  rules,
  selectedRowId,
  selectedRowIds,
  processing,
  progress,
  message,
  canUndo,
  canRedo,
  selectedRow,
  differenceCount,
  acceptedCount,
  unresolvedCount,
  runAlignment,
  recalculate,
  updateRow,
  shiftPairing,
  moveRow,
  addOpinion,
  removeOpinion,
  adoptOpinion,
  unadoptOpinion,
  setRejectionReason,
  acceptRows,
  acceptAll,
  nextDifference,
  addVersion,
  undo,
  redo,
  exportMarkdown,
  exportJson
} = useCollation();

const HANDLER_STORAGE_KEY = 'sologsb-1023/handler';

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const opinionDraft = ref({ note: '', source: '', handler: localStorage.getItem(HANDLER_STORAGE_KEY) ?? '' });
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 310 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 112, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 310 },
  { title: '意见 / 采纳结论', dataIndex: 'note', slotName: 'note', width: 260 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    if (!query) return true;
    const searchable = [
      row.left?.text,
      row.right?.text,
      row.systemNote,
      statusLabel(row.status),
      ...row.opinions.flatMap((opinion) => [opinion.note, opinion.source, opinion.handler])
    ]
      .filter(Boolean)
      .map((value) => value!.toLocaleLowerCase());
    return searchable.some((value) => value.includes(query));
  });
});

const selectedAdoptedOpinion = computed(() => {
  const row = selectedRow.value;
  return row?.opinions.find((opinion) => opinion.id === row.adoptedOpinionId) ?? null;
});

const pendingRejectionCount = computed(() => {
  const row = selectedRow.value;
  if (!row || !row.adoptedOpinionId) return 0;
  return row.opinions.filter(
    (opinion) => opinion.id !== row.adoptedOpinionId && !opinion.rejectionReason.trim()
  ).length;
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

function adoptedOf(row: AlignmentRow) {
  return row.opinions.find((opinion) => opinion.id === row.adoptedOpinionId) ?? null;
}

function adoptedSummary(row: AlignmentRow) {
  const note = adoptedOf(row)?.note ?? '';
  return note.length > 26 ? `${note.slice(0, 26)}…` : note;
}

function formatTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN');
}

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function rowClass(record: AlignmentRow) {
  return record.id === selectedRowId.value ? 'row-active' : '';
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const row = record as unknown as AlignmentRow;
  selectedRowId.value = row.id;
}

function appendOpinion() {
  if (!selectedRow.value) return;
  if (!opinionDraft.value.note.trim()) {
    Message.warning('请先填写意见内容');
    return;
  }
  const ok = addOpinion(selectedRow.value.id, opinionDraft.value);
  if (ok) {
    localStorage.setItem(HANDLER_STORAGE_KEY, opinionDraft.value.handler.trim());
    opinionDraft.value = { note: '', source: '', handler: opinionDraft.value.handler };
    Message.success('已追加意见，此前的意见均保留');
  }
}

function onRejectionReason(rowId: string, opinionId: string, value: string | Event) {
  const reason = typeof value === 'string' ? value : (value.target as HTMLInputElement).value;
  setRejectionReason(rowId, opinionId, reason);
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (kind === 'markdown') {
    download('校勘记.md', exportMarkdown(), 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', exportJson(), 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    acceptRows(selectedRowIds.value.map(String));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">自动对齐、人工修正、校记导出，全程本地保存</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-dropdown>
            <a-button>导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select v-model="leftVersionId" aria-label="底本">
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select v-model="rightVersionId" aria-label="参校本">
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；重算会进入撤销历史。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待校勘</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">已接受</div>
            </div>
            <div class="stat-card">
              <div class="stat-number">{{ rows.length }}</div>
              <div class="stat-label">对齐句段</div>
            </div>
          </div>
          <a-button long type="primary" status="success" style="margin-top: 12px" :disabled="!unresolvedCount" @click="acceptAll">
            批量接受（跳过无采纳结论的行）
          </a-button>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未接受差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选建议</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记或来源" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="acceptRows(selectedRowIds.map(String))"
            >
              接受勾选建议
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚未接受</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1160, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
            </template>

            <template #left="{ record }">
              <div v-if="record.left">
                <div class="paragraph-label">段 {{ record.left.paragraphOrder }} · 句 {{ record.left.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.left.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">整行下移</a-button>
                <a-tooltip content="无采纳结论时批量接受会跳过该行">
                  <a-button size="mini" status="success" @click.stop="acceptRows([record.id])">接受</a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <div v-if="record.right">
                <div class="paragraph-label">段 {{ record.right.paragraphOrder }} · 句 {{ record.right.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.right.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
            </template>

            <template #note="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <div v-if="record.systemNote" style="color: #86909c">{{ record.systemNote }}</div>
                <div>
                  {{ record.opinions.length ? `共 ${record.opinions.length} 条意见` : '暂无意见' }}
                </div>
                <div v-if="adoptedOf(record)" style="margin-top: 4px; color: #00875a">
                  已采纳：{{ adoptedSummary(record) }}
                </div>
                <a-tag v-if="record.accepted" size="small" color="green" style="margin-top: 7px">已完成</a-tag>
                <a-tag v-else size="small" color="orange" style="margin-top: 7px">待处理·未采纳</a-tag>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedRow" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedRow.status) }}</a-tag>
          </div>
        </section>

        <template v-if="selectedRow">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
            <a-select :model-value="selectedRow.status" style="width: 100%" @change="updateStatus">
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div class="diff-text same">{{ selectedRow.left?.text || '（无）' }}</div>
            <div style="height: 8px" />
            <div class="diff-text changed">{{ selectedRow.right?.text || '（无）' }}</div>
          </section>

          <section class="panel-section">
            <div style="display: flex; align-items: center; margin-bottom: 10px">
              <span style="color: #86909c; font-size: 12px">校勘意见（{{ selectedRow.opinions.length }} 条，可追加）</span>
              <a-tag v-if="selectedAdoptedOpinion" size="small" color="green" style="margin-left: auto">已有结论</a-tag>
              <a-tag v-else size="small" color="orange" style="margin-left: auto">未采纳</a-tag>
            </div>
            <a-empty v-if="!selectedRow.opinions.length" description="还没有意见，可在下方追加" />
            <div
              v-for="(opinion, opinionIndex) in selectedRow.opinions"
              :key="opinion.id"
              class="opinion-card"
              :class="{ adopted: opinion.id === selectedRow.adoptedOpinionId }"
            >
              <div style="font-size: 13px; line-height: 1.6">
                {{ opinionIndex + 1 }}. {{ opinion.note }}
              </div>
              <div class="opinion-meta">
                来源：{{ opinion.source || '未注明' }} · 处理人：{{ opinion.handler }} · {{ formatTime(opinion.createdAt) }}
              </div>
              <div v-if="opinion.id === selectedRow.adoptedOpinionId" style="margin-top: 8px">
                <a-tag size="small" color="green">已采纳</a-tag>
                <a-button size="mini" style="margin-left: 8px" @click="unadoptOpinion(selectedRow.id)">撤销采纳</a-button>
              </div>
              <template v-else>
                <div style="margin-top: 8px; display: flex; gap: 8px">
                  <a-button size="mini" type="primary" status="success" @click="adoptOpinion(selectedRow.id, opinion.id)">
                    采纳此条
                  </a-button>
                  <a-popconfirm content="确定删除这条意见？可通过撤销恢复" @ok="removeOpinion(selectedRow.id, opinion.id)">
                    <a-button size="mini" status="danger">删除</a-button>
                  </a-popconfirm>
                </div>
                <a-input
                  v-if="selectedRow.adoptedOpinionId"
                  size="small"
                  style="margin-top: 8px"
                  :model-value="opinion.rejectionReason"
                  placeholder="否决原因：说明为何不采纳这条意见"
                  @change="(value: string) => onRejectionReason(selectedRow!.id, opinion.id, value)"
                />
              </template>
            </div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">追加新意见（不会覆盖已有意见）</div>
            <a-textarea
              v-model="opinionDraft.note"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 3, maxRows: 8 }"
            />
            <a-input v-model="opinionDraft.source" placeholder="来源，如：某刻本、某整理稿" style="margin-top: 8px" />
            <a-input v-model="opinionDraft.handler" placeholder="处理人（署名，会记住上次填写）" style="margin-top: 8px" />
            <a-button long type="primary" style="margin-top: 8px" @click="appendOpinion">追加意见</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              配对移动只交换左栏句段，不会改写底本或参校本原文。
            </a-alert>
          </section>

          <section class="panel-section">
            <a-alert v-if="selectedRow.status === 'same'" type="success" :show-icon="true">
              两本完全相同，无需校勘结论。
            </a-alert>
            <template v-else-if="selectedAdoptedOpinion">
              <a-alert type="success" :show-icon="true">
                已完成：采纳了「{{ selectedAdoptedOpinion.handler }}」的意见，导出时其余意见将连同否决原因一并保留。
              </a-alert>
              <a-alert v-if="pendingRejectionCount" type="warning" :show-icon="true" style="margin-top: 8px">
                还有 {{ pendingRejectionCount }} 条被否决的意见未填写否决原因。
              </a-alert>
            </template>
            <a-alert v-else type="warning" :show-icon="true">
              尚未采纳结论：此行不算完成，批量接受会跳过。请从上方意见中采纳一条。
            </a-alert>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可调整错位、追加多条意见并采纳一条结论</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据保存在当前浏览器，刷新后继续。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>
</template>
