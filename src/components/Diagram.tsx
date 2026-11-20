import type { KeyboardEvent } from 'react';
import type { Computed, ProjectUI } from '../model';

interface Props {
  project: ProjectUI;
  computed: Computed;
  selected: string;
  onSelect: (id: string) => void;
}

const BOX = 120;
const GAP = 46;
const H = 190;

/** Linear process diagram: source tank -> elements in flow order -> destination tank. Click to select. */
export function Diagram({ project, computed, selected, onSelect }: Props) {
  const n = project.elements.length;
  const W = 40 + (n + 2) * BOX + (n + 1) * GAP + 40;
  const cy = 82;
  const xOf = (i: number) => 40 + i * (BOX + GAP);
  const a = computed.analysis;
  const ok = computed.op?.status === 'ok';
  const L = (v: number, d = 2) => v.toFixed(d);
  const interact = (id: string, label: string) => ({
    onClick: () => onSelect(id),
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') onSelect(id);
    },
  });

  const tank = (i: number, id: 'source' | 'dest', title: string, level: number, head: number | undefined) => {
    const x = xOf(i);
    const fill = Math.max(0.15, Math.min(0.9, level / (level + 2)));
    return (
      <g className={`node ${selected === id ? 'sel' : ''}`} {...interact(id, title)}>
        <rect x={x} y={cy - 46} width={BOX} height={92} rx={6} className="tank" />
        <rect x={x + 2} y={cy + 44 - 90 * fill} width={BOX - 4} height={90 * fill} className="water" />
        <text x={x + BOX / 2} y={cy - 4} textAnchor="middle" className="t-title">{title}</text>
        <text x={x + BOX / 2} y={cy + 14} textAnchor="middle" className="t-sub">level {L(level, 1)} m</text>
        {head !== undefined && <text x={x + BOX / 2} y={cy + 66} textAnchor="middle" className="t-sub">h = {L(head, 1)} m</text>}
      </g>
    );
  };

  const link = (i: number) => {
    const x1 = xOf(i) + BOX;
    const x2 = xOf(i + 1);
    return (
      <g key={`l${i}`}>
        <line x1={x1} y1={cy} x2={x2 - 6} y2={cy} className="flow-line" />
        <path d={`M${x2 - 8},${cy - 5} L${x2},${cy} L${x2 - 8},${cy + 5} Z`} className="arrow" />
      </g>
    );
  };

  let pipeI = 0;
  let pumpI = 0;
  return (
    <div className="diagram-scroll">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="System diagram">
        {Array.from({ length: n + 1 }, (_, i) => link(i))}
        {tank(0, 'source', 'Source tank', project.source.levelM, a?.nodes[0]?.headM)}
        {project.elements.map((el, k) => {
          const x = xOf(k + 1);
          const cls = `node ${selected === el.uid ? 'sel' : ''}`;
          if (el.kind === 'pipe') {
            const res = a?.pipes[pipeI++];
            return (
              <g key={el.uid} className={cls} {...interact(el.uid, el.name)}>
                <rect x={x} y={cy - 22} width={BOX} height={44} rx={22} className="pipe" />
                <text x={x + BOX / 2} y={cy - 2} textAnchor="middle" className="t-title">{el.name}</text>
                <text x={x + BOX / 2} y={cy + 14} textAnchor="middle" className="t-sub">{el.lengthM} m · {el.diameterMm} mm</text>
                {res && ok && (
                  <>
                    <text x={x + BOX / 2} y={cy + 46} textAnchor="middle" className="t-res">v {L(res.flow.velocity)} m/s</text>
                    <text x={x + BOX / 2} y={cy + 62} textAnchor="middle" className="t-res">Re {Math.round(res.flow.reynolds).toLocaleString()}</text>
                    <text x={x + BOX / 2} y={cy + 78} textAnchor="middle" className="t-res">Δh {L(res.flow.totalHeadLoss)} m</text>
                  </>
                )}
              </g>
            );
          }
          const res = a?.pumps[pumpI++];
          return (
            <g key={el.uid} className={cls} {...interact(el.uid, el.name)}>
              <circle cx={x + BOX / 2} cy={cy} r={34} className="pump" />
              <path d={`M${x + BOX / 2 - 12},${cy - 14} L${x + BOX / 2 + 16},${cy} L${x + BOX / 2 - 12},${cy + 14} Z`} className="pump-icon" />
              <text x={x + BOX / 2} y={cy - 42} textAnchor="middle" className="t-title">{el.name}</text>
              {res && ok && (
                <>
                  <text x={x + BOX / 2} y={cy + 52} textAnchor="middle" className="t-res">H {L(res.headM)} m</text>
                  {res.shaftPowerW !== undefined && <text x={x + BOX / 2} y={cy + 68} textAnchor="middle" className="t-res">P {L(res.shaftPowerW / 1000)} kW</text>}
                  {res.npshMarginM !== undefined && (
                    <text x={x + BOX / 2} y={cy + 84} textAnchor="middle" className={res.warnings.length ? 't-warn' : 't-res'}>NPSH margin {L(res.npshMarginM)} m</text>
                  )}
                </>
              )}
            </g>
          );
        })}
        {tank(n + 1, 'dest', 'Destination tank', project.destination.levelM, a?.nodes[a.nodes.length - 1]?.headM)}
      </svg>
    </div>
  );
}
