/* 冒烟测试：多意见追加 / 采纳 / 否决原因 / 批量接受跳过 / 撤销 / 旧草稿迁移 */
// @ts-nocheck
(globalThis as any).window = globalThis;
const store: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = String(v);
  },
  removeItem: (k: string) => {
    delete store[k];
  }
};

const KEY = 'sologsb-1023/multi-version-collation/v1';
let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`ok   - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}`);
  }
}

const { useCollation } = await import('../src/composables/useCollation');
const c = useCollation();
await c.runAlignment(false);

const row = c.rows.value.find((r: any) => r.status !== 'same');
check('存在差异行', !!row);
const getRow = () => c.rows.value.find((r: any) => r.id === row.id);

// 1. 同一处异文可追加多条意见，后写不覆盖前一条
c.addOpinion(row.id, { note: '甲说当作“涉川”', source: '宋刻本', handler: '张三' });
c.addOpinion(row.id, { note: '乙说当作“涉水”', source: '帛书整理稿', handler: '李四' });
check('两条意见均保留', row.opinions.length === 2);
check('意见带来源与处理人', row.opinions[0].handler === '张三' && row.opinions[1].source === '帛书整理稿');

// 2. 无采纳结论时批量接受会跳过
c.acceptAll();
check('无结论行不被批量接受', !getRow().accepted);
check('跳过提示已给出', c.message.value.includes('跳过'));

// 3. 采纳一条，其余写否决原因
const [op1, op2] = row.opinions;
c.adoptOpinion(row.id, op1.id);
check('采纳后行算完成', getRow().accepted && getRow().adoptedOpinionId === op1.id);
c.setRejectionReason(row.id, op2.id, '与底本用字不合');
check('否决原因已记录', getRow().opinions[1].rejectionReason === '与底本用字不合');

// 4. 导出包含全部意见与采纳结果
const md = c.exportMarkdown();
check('Markdown 含全部意见', md.includes('甲说当作') && md.includes('乙说当作'));
check('Markdown 含采纳结论', md.includes('已采纳第 1 条意见'));
check('Markdown 含否决原因', md.includes('否决原因：与底本用字不合'));
const json = JSON.parse(c.exportJson());
const jrow = json.rows.find((r: any) => r.id === row.id);
check('JSON 含全部意见', jrow.opinions.length === 2);
check('JSON 含采纳结果', jrow.adoptedOpinion?.id === op1.id && jrow.rejectedOpinions.length === 1);
check('JSON 含统计', typeof json.summary.resolvedRows === 'number');

// 5. 撤销可回退采纳与否决原因
c.undo();
check('撤销否决原因', getRow().opinions[1].rejectionReason === '');
c.undo();
check('撤销采纳后行重新待处理', !getRow().accepted && getRow().adoptedOpinionId === null);
c.redo();
check('重做恢复采纳', getRow().accepted && getRow().adoptedOpinionId === op1.id);

// 6. 旧草稿迁移：构造 v1 之前的单行校记格式，经 undo 触发 restore 迁移
const legacy = JSON.parse(store[KEY]);
legacy.rows = legacy.rows.map((r: any, i: number) => {
  const { opinions, adoptedOpinionId, systemNote, ...rest } = r;
  return {
    ...rest,
    note: i === 0 ? '旧校记：此处疑为衍文' : '',
    source: i === 0 ? '旧来源：某抄本' : i === 1 ? '自动补齐右侧新增内容' : '',
    accepted: i < 3
  };
});
c.history.value.push(JSON.stringify(legacy));
c.undo();
const migrated = c.rows.value;
check('迁移后每行都有意见数组', migrated.every((r: any) => Array.isArray(r.opinions)));
check(
  '旧校记迁移为意见',
  migrated[0].opinions.some((o: any) => o.note === '旧校记：此处疑为衍文' && o.source === '旧来源：某抄本')
);
check(
  '旧自动提示迁移为对齐说明',
  migrated[1].systemNote === '自动补齐右侧新增内容' && migrated[1].opinions.length === 0
);
const acceptedDiff = migrated.filter((r: any) => r.status !== 'same' && r.accepted);
check('旧草稿已接受的差异行迁移后仍有采纳结论', acceptedDiff.every((r: any) => !!r.adoptedOpinionId));
check('迁移后无结论的差异行不算完成', migrated.filter((r: any) => r.status !== 'same' && !r.adoptedOpinionId).every((r: any) => !r.accepted));

// 7. 迁移后可继续处理：追加意见并采纳
const target = migrated.find((r: any) => r.status !== 'same' && !r.adoptedOpinionId);
if (target) {
  c.addOpinion(target.id, { note: '迁移后新增意见', source: '复核', handler: '王五' });
  c.adoptOpinion(target.id, target.opinions[target.opinions.length - 1].id);
  check('迁移后可继续追加并采纳', target.accepted);
} else {
  check('迁移后可继续追加并采纳（无待处理行可测，跳过）', true);
}

// 8. 刷新持久化：localStorage 中为新格式
check('刷新后草稿含意见列表', (store[KEY] ?? '').includes('"opinions"'));

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
