import React, { useState, useEffect, useRef, useMemo } from 'react';
import JSZip from 'jszip';
import { buildXlsx, parseXlsx } from './xlsx-lite.js';

// ─── Constants & Config ─────────────────────────────────────────
const STORAGE_KEY = 'capacity-planner-v3';
const DEFAULT_LEVELS = [
  { level: 1, label: 'Level 1 – Strategy/Executive', annualTarget: 1100, costPerHour: 350 },
  { level: 2, label: 'Level 2 – Senior Strategy', annualTarget: 1250, costPerHour: 285 },
  { level: 3, label: 'Level 3 – Senior Manager', annualTarget: 1400, costPerHour: 225 },
  { level: 4, label: 'Level 4 – Manager', annualTarget: 1500, costPerHour: 180 },
  { level: 5, label: 'Level 5 – Senior Associate', annualTarget: 1600, costPerHour: 140 },
  { level: 6, label: 'Level 6 – Associate', annualTarget: 1700, costPerHour: 105 },
  { level: 7, label: 'Level 7 – Support', annualTarget: 1800, costPerHour: 80 },
];
const DEFAULT_CHAIR_WEIGHTS = { 1: 0.20, 2: 0.40, 3: 0.65, 4: 0.85, 5: 1.00 };
const CHAIR_LABELS = { 1: 'Lead', 2: '2nd Chair', 3: '3rd Chair', 4: '4th Chair', 5: '5th Chair' };
const CHAIR_LEVEL_MAP = { 1: [1, 3], 2: [2, 4], 3: [3, 5], 4: [4, 6], 5: [5, 7] };
const PLACEHOLDER_IDS = ['__TBD__', '__OPEN__'];
const isPlaceholder = (id) => PLACEHOLDER_IDS.includes(id);
const placeholderLabel = (id) => id === '__TBD__' ? 'TBD' : id === '__OPEN__' ? 'Open' : id;
const COHORTS = ['Service', 'Financial', 'Advisory', 'Other'];
const PERSON_TYPES = ['Core', 'Non-Core', 'Contractor', 'Borrowed'];
const COHORT_COLORS = {
  Service: { bg: '#dbeafe', fg: '#1e40af' },
  Financial: { bg: '#fef3c7', fg: '#92400e' },
  Advisory: { bg: '#dcfce7', fg: '#166534' },
  Other: { bg: '#f0f1f5', fg: '#6b7280' },
};
const COMPLEXITY_COLORS = { 1: '#6b7280', 2: '#3b82f6', 3: '#f59e0b', 4: '#f97316', 5: '#ef4444' };
const ADMIN_HASH = 'c42152dba91420e2defa3b908e0d87954736e19740709b1b9a9e7bb5ab4c2dd5';

const CLIENT_STATUSES = ['Active', 'Prospect', 'Won'];

const DEFAULT_SETTINGS = {
  levels: DEFAULT_LEVELS,
  chairWeights: { ...DEFAULT_CHAIR_WEIGHTS },
  thresholds: { green: 80, yellow: 100 },
  baseHoursPerComplexity: 220,
  markets: [],
};

function calcRealization(cost, revenue) {
  if (!revenue || revenue === 0) return null;
  return { multiplier: Math.round(revenue / cost * 100) / 100, margin: Math.round((revenue - cost) / revenue * 100) };
}

function utilColor(util, thresholds) {
  if (util <= (thresholds?.green || 80)) return '#22c55e';
  if (util <= (thresholds?.yellow || 100)) return '#f59e0b';
  return '#ef4444';
}

// ─── Utilities ──────────────────────────────────────────────────
let _idCounter = 0;
const uid = () => Date.now().toString(36) + (++_idCounter).toString(36) + Math.random().toString(36).slice(2, 6);

function fmtDol(v) { return '$' + Math.round(v / 1000).toLocaleString() + 'k'; }
function fmtDol1(v) { return '$' + (v / 1000).toFixed(1).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + 'k'; }
function pct(v) { return Math.round(v) + '%'; }

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function assignmentCohort(a, people) {
  if (a.assignmentCohort) return a.assignmentCohort;
  return (people.find(p => p.id === a.personId)?.cohorts || ['Service'])[0];
}

function getTarget(person, settings) {
  if (person.targetOverride) return person.targetOverride;
  const lv = settings.levels.find(l => l.level === person.level);
  return lv ? lv.annualTarget : 1500;
}

function calcHours(complexity, chairPosition, settings) {
  const w = (settings.chairWeights || DEFAULT_CHAIR_WEIGHTS)[chairPosition] || 1;
  return complexity * (settings.baseHoursPerComplexity || 220) * w;
}

function calcPersonHours(personId, assignments, clients, settings) {
  let hours = 0, prospectHours = 0;
  assignments.filter(a => a.personId === personId).forEach(a => {
    const c = clients.find(cl => cl.id === a.clientId);
    if (!c) return;
    const h = a.hoursOverride || calcHours(c.complexity, a.chairPosition, settings);
    if (c.clientStatus === 'Prospect') prospectHours += h;
    else hours += h;
  });
  return { hours, prospectHours };
}

function calcUtil(personId, assignments, clients, settings) {
  const { hours, prospectHours } = calcPersonHours(personId, assignments, clients, settings);
  const person = null; // caller should provide
  return { hours, prospectHours };
}

function getPersonUtil(person, assignments, clients, settings) {
  const { hours, prospectHours } = calcPersonHours(person.id, assignments, clients, settings);
  const target = getTarget(person, settings);
  return { hours, prospectHours, target, util: target > 0 ? (hours / target) * 100 : 0, prospectUtil: target > 0 ? ((hours + prospectHours) / target) * 100 : 0 };
}

function calcClientHours(clientId, assignments, settings, client) {
  return assignments.filter(a => a.clientId === clientId).reduce((sum, a) => {
    return sum + (a.hoursOverride || calcHours(client.complexity, a.chairPosition, settings));
  }, 0);
}

function calcClientCost(clientId, assignments, people, settings, client) {
  return assignments.filter(a => a.clientId === clientId).reduce((sum, a) => {
    const h = a.hoursOverride || calcHours(client.complexity, a.chairPosition, settings);
    const p = people.find(pp => pp.id === a.personId);
    const lv = p ? settings.levels.find(l => l.level === p.level) : null;
    const rate = lv ? lv.costPerHour : 150;
    return sum + h * rate;
  }, 0);
}

// ─── CSS-in-JS Helpers ──────────────────────────────────────────
const css = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1050, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.1)', padding: 24 },
  btn: (bg = '#6366f1', fg = '#fff') => ({
    background: bg, color: fg, border: 'none', borderRadius: 8, padding: '8px 16px',
    fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui',
    transition: 'filter 0.15s ease, transform 0.15s ease',
  }),
  btnSm: (bg = '#6366f1', fg = '#fff') => ({
    ...css.btn(bg, fg), padding: '5px 12px', fontSize: 13,
  }),
  input: { border: '1.5px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: 'system-ui', outline: 'none', transition: 'border-color 0.15s ease, box-shadow 0.15s ease', width: '100%' },
  select: { border: '1.5px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 14, fontFamily: 'system-ui', outline: 'none', background: '#fff', cursor: 'pointer' },
  badge: (bg, fg) => ({ display: 'inline-block', background: bg, color: fg, padding: '2px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600 }),
  th: { padding: '10px 12px', fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left', borderBottom: '2px solid #e5e7eb', position: 'sticky', top: 0, background: '#fff', zIndex: 2 },
  td: { padding: '10px 12px', fontSize: 14, borderBottom: '1px solid #f0f1f5' },
  sectionTitle: { fontSize: 18, fontWeight: 700, color: '#1a1f36', marginBottom: 12 },
  label: { fontSize: 13, fontWeight: 600, color: '#6b7280', marginBottom: 4 },
  panelBox: (w = 'min(800px, 95vw)') => ({ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: w, maxHeight: '90vh', background: '#fff', boxShadow: '0 8px 40px rgba(0,0,0,0.2)', zIndex: 1001, display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }),
  panelHdr: { padding: '18px 22px', borderBottom: '2px solid #e5e7eb', flexShrink: 0, background: '#1a1f36', color: '#fff' },
};

// ─── Global CSS (injected once) ──────────────────────────────────
const GLOBAL_CSS = `
@keyframes fadeIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
@keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes spin { to { transform: rotate(360deg); } }
button:hover { filter: brightness(0.95); }
button:active { transform: scale(0.97); }
button:disabled { opacity: 0.5; pointer-events: none; }
input:focus, select:focus, textarea:focus { border-color: #6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.15) !important; }
tr:hover td { background: #f9fafb; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
@media print { * { transition: none !important; } }
`;

function injectCSS() {
  if (document.getElementById('cp-global-css')) return;
  const s = document.createElement('style');
  s.id = 'cp-global-css';
  s.textContent = GLOBAL_CSS;
  document.head.appendChild(s);
}

// ─── Spinner Component ──────────────────────────────────────────
function Spinner({ size = 32 }) {
  return <div style={{ width: size, height: size, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />;
}

// ─── SearchSelect Component ─────────────────────────────────────
function SearchSelect({ options, value, onChange, placeholder = 'Select...', style = {} }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const filtered = options.filter(o => (o.label || o).toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const display = value ? (options.find(o => (o.value || o) === value)?.label || value) : placeholder;

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <div onClick={() => setOpen(!open)} style={{ ...css.input, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff' }}>
        <span style={{ color: value ? '#1a1f36' : '#9ca3af' }}>{display}</span>
        <span style={{ color: '#9ca3af', fontSize: 10 }}>▼</span>
      </div>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 100, marginTop: 4, maxHeight: 240, overflow: 'auto' }}>
          <div style={{ padding: 8 }}>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ ...css.input, fontSize: 13 }} />
          </div>
          {filtered.map((o, i) => {
            const val = o.value || o;
            const lab = o.label || o;
            return <div key={i} onClick={() => { onChange(val); setOpen(false); setSearch(''); }} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, background: val === value ? '#eef2ff' : 'transparent' }}>{lab}</div>;
          })}
          {filtered.length === 0 && <div style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 13 }}>No results</div>}
        </div>
      )}
    </div>
  );
}

// ─── Modal Wrapper ──────────────────────────────────────────────
function Modal({ children, onClose, width = 'min(800px, 95vw)', height }) {
  return (
    <div style={css.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width, height: height || 'auto', maxHeight: '90vh', background: '#fff', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', overflow: 'auto', animation: 'fadeIn 0.2s ease' }}>
        {children}
      </div>
    </div>
  );
}

// ─── Sample Data ────────────────────────────────────────────────
const SAMPLE_DATA = {
  people: [
    { id: 'p28', name: 'Daniel Bell', cohorts: ['Service', 'Financial'], level: 1, targetOverride: null, manager: null, pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p1', name: 'Priya Rivera', cohorts: ['Service'], level: 2, targetOverride: null, manager: null, pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p15', name: 'Sophia Singh', cohorts: ['Service'], level: 2, targetOverride: null, manager: null, pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p19', name: 'James Hughes', cohorts: ['Service'], level: 2, targetOverride: null, manager: null, pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p46', name: 'Daniel Chen', cohorts: ['Financial', 'Service'], level: 2, targetOverride: null, manager: null, pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p2', name: 'Elena Reed', cohorts: ['Service'], level: 3, targetOverride: null, manager: 'Priya Rivera', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p9', name: 'Andrew Butler', cohorts: ['Service'], level: 3, targetOverride: null, manager: 'James Hughes', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p17', name: 'Andrew Bennett', cohorts: ['Service'], level: 3, targetOverride: null, manager: 'James Hughes', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p32', name: 'Samantha Mitchell', cohorts: ['Service'], level: 3, targetOverride: null, manager: 'James Hughes', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p38', name: 'Jordan Ruiz', cohorts: ['Financial'], level: 3, targetOverride: null, manager: 'Daniel Chen', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p47', name: 'Angela Howard', cohorts: ['Financial'], level: 3, targetOverride: null, manager: 'Daniel Chen', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p50', name: 'Emily Singh', cohorts: ['Financial'], level: 3, targetOverride: null, manager: 'Daniel Bell', pod: 'Financial Ops', type: 'Contractor', notes: '', lastModified: null },
    { id: 'p3', name: 'Amy Griffin', cohorts: ['Service'], level: 4, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p5', name: 'Sarah Goldstein', cohorts: ['Service'], level: 4, targetOverride: null, manager: 'James Hughes', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p8', name: 'Hannah Moreno', cohorts: ['Service'], level: 4, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p11', name: 'Ryan Barnes', cohorts: ['Service'], level: 4, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p18', name: 'Andrew Murphy', cohorts: ['Service'], level: 4, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p24', name: 'Robert Cooper', cohorts: ['Service'], level: 4, targetOverride: null, manager: 'James Hughes', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p27', name: 'Amy Clark', cohorts: ['Service'], level: 4, targetOverride: null, manager: 'Samantha Mitchell', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p30', name: 'Dana Price', cohorts: ['Service'], level: 4, targetOverride: null, manager: 'Andrew Bennett', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p31', name: 'Lauren Sullivan', cohorts: ['Service'], level: 4, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p35', name: 'Evan Douglas', cohorts: ['Service'], level: 4, targetOverride: null, manager: 'Elena Reed', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p6', name: 'Catherine Moreno', cohorts: ['Service'], level: 5, targetOverride: null, manager: 'Priya Rivera', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p13', name: 'Elena Phillips', cohorts: ['Service'], level: 5, targetOverride: null, manager: 'Priya Rivera', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p25', name: 'Ari Evans', cohorts: ['Service'], level: 5, targetOverride: null, manager: 'Priya Rivera', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p26', name: 'Robert Sanders', cohorts: ['Service'], level: 5, targetOverride: null, manager: 'Andrew Bennett', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p29', name: 'Catherine Kim', cohorts: ['Service'], level: 5, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p44', name: 'Scott Phillips', cohorts: ['Financial'], level: 5, targetOverride: null, manager: 'Angela Howard', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p45', name: 'Evan Watson', cohorts: ['Financial'], level: 5, targetOverride: null, manager: 'Angela Howard', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p49', name: 'Kara Long', cohorts: ['Financial'], level: 5, targetOverride: null, manager: 'Emily Singh', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p4', name: 'Scott Long', cohorts: ['Service'], level: 6, targetOverride: null, manager: 'Catherine Kim', pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p10', name: 'James Wallace', cohorts: ['Service'], level: 6, targetOverride: null, manager: 'Sophia Singh', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p33', name: 'Scott Wallace', cohorts: ['Service'], level: 6, targetOverride: null, manager: 'Andrew Butler', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p34', name: 'Alex Howard', cohorts: ['Service'], level: 6, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p36', name: 'Sarah Perry', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Jordan Ruiz', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p37', name: 'Sarah Reeves', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Jordan Ruiz', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p39', name: 'Patrick Price', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Angela Howard', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p40', name: 'James Kim', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Emily Singh', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p41', name: 'Brian Chen', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Angela Howard', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p42', name: 'David Ruiz', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Emily Singh', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p43', name: 'Rebecca Hayes', cohorts: ['Financial'], level: 6, targetOverride: null, manager: 'Jordan Ruiz', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p7', name: 'Sophia Long', cohorts: ['Service'], level: 7, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p12', name: 'Kevin Singh', cohorts: ['Service'], level: 7, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p14', name: 'Amy Park', cohorts: ['Service'], level: 7, targetOverride: null, manager: 'Sophia Singh', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p16', name: 'Hannah Liu', cohorts: ['Financial'], level: 7, targetOverride: null, manager: 'Emily Singh', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
    { id: 'p20', name: 'Alex Singh', cohorts: ['Service'], level: 7, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p21', name: 'Heather Campbell', cohorts: ['Service'], level: 7, targetOverride: null, manager: 'Elena Reed', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p22', name: 'Lauren Powell', cohorts: ['Service'], level: 7, targetOverride: null, manager: null, pod: 'Service West', type: 'Core', notes: '', lastModified: null },
    { id: 'p23', name: 'Alex Rivera', cohorts: ['Service'], level: 7, targetOverride: null, manager: 'Andrew Bennett', pod: 'Service East', type: 'Core', notes: '', lastModified: null },
    { id: 'p48', name: 'David Perry', cohorts: ['Financial'], level: 7, targetOverride: null, manager: 'Jordan Ruiz', pod: 'Financial Ops', type: 'Core', notes: '', lastModified: null },
  ],
  clients: [
    { id: 'c1', name: 'Lakeview Health Systems', complexity: 1, hoursBudget: null, revenue: 73000, market: 'Healthcare', notes: '', clientType: 'Ongoing', feeType: 'Retainer', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c2', name: 'Bridgewater Investments', complexity: 1, hoursBudget: null, revenue: 51000, market: 'Southeast', notes: '', clientType: 'Ongoing', feeType: 'Retainer', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c3', name: 'Summit Associates', complexity: 1, hoursBudget: null, revenue: 83000, market: 'Northeast', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c4', name: 'Ridgeline Associates', complexity: 2, hoursBudget: null, revenue: 129000, market: 'Mid-Atlantic', notes: '', clientType: 'Ongoing', feeType: 'T&M', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c5', name: 'Meridian Group', complexity: 2, hoursBudget: null, revenue: 173000, market: 'Healthcare', notes: '', clientType: 'Ongoing', feeType: 'Retainer', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c6', name: 'Crestview Solutions', complexity: 2, hoursBudget: null, revenue: 191000, market: 'Central', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c7', name: 'Riverview Development', complexity: 2, hoursBudget: null, revenue: 156000, market: 'Technology', notes: '', clientType: 'Ongoing', feeType: 'Fixed Fee', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c8', name: 'Broadview Capital', complexity: 2, hoursBudget: null, revenue: 127000, market: 'Mid-Atlantic', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c9', name: 'Lakeview Resources', complexity: 3, hoursBudget: null, revenue: 363000, market: 'Financial Services', notes: '', clientType: 'Ongoing', feeType: 'Fixed Fee', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c10', name: 'Crossroads Partners', complexity: 3, hoursBudget: null, revenue: 352000, market: 'Technology', notes: '', clientType: 'Ongoing', feeType: 'Retainer', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c11', name: 'Broadview Partners', complexity: 3, hoursBudget: null, revenue: 326000, market: 'Industrial', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c12', name: 'Evergreen Holdings', complexity: 3, hoursBudget: null, revenue: 257000, market: 'Central', notes: '', clientType: 'Project', feeType: 'Fixed Fee', endDate: '2026-12-30', clientStatus: 'Active', projects: [{ id: 'proj1', name: 'ERP Implementation', description: 'Primary engagement workstream', startDate: '2025-10-01', endDate: '2026-12-30', hoursBudget: 502, status: 'Active' }], revenueBreakdown: [], lastModified: null },
    { id: 'c13', name: 'Crestview Management', complexity: 3, hoursBudget: null, revenue: 235000, market: 'Healthcare', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c14', name: 'Whitfield Technologies', complexity: 3, hoursBudget: null, revenue: 264000, market: 'Central', notes: '', clientType: 'Project', feeType: 'Hybrid', endDate: '2026-12-30', clientStatus: 'Active', projects: [{ id: 'proj2', name: 'Restructuring', description: 'Primary engagement workstream', startDate: '2025-08-01', endDate: '2026-12-30', hoursBudget: 418, status: 'Active' }], revenueBreakdown: [], lastModified: null },
    { id: 'c15', name: 'Cascade Solutions', complexity: 3, hoursBudget: null, revenue: 243000, market: 'Central', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c16', name: 'Pacific Manufacturing', complexity: 3, hoursBudget: null, revenue: 360000, market: 'Mid-Atlantic', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c17', name: 'Atlas Solutions', complexity: 4, hoursBudget: null, revenue: 496000, market: 'Technology', notes: '', clientType: 'Project', feeType: 'Hybrid', endDate: '2026-12-30', clientStatus: 'Active', projects: [{ id: 'proj3', name: 'IPO Readiness', description: 'Primary engagement workstream', startDate: '2025-12-01', endDate: '2026-12-30', hoursBudget: 478, status: 'Active' }], revenueBreakdown: [], lastModified: null },
    { id: 'c18', name: 'Meridian Management', complexity: 4, hoursBudget: null, revenue: 529000, market: 'Northeast', notes: '', clientType: 'Ongoing', feeType: 'Fixed Fee', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c19', name: 'Beacon Services', complexity: 4, hoursBudget: null, revenue: 429000, market: 'Southeast', notes: '', clientType: 'Ongoing', feeType: 'T&M', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c20', name: 'Keystone Partners', complexity: 4, hoursBudget: null, revenue: 364000, market: 'Central', notes: '', clientType: 'Project', feeType: 'Hybrid', endDate: '2026-06-30', clientStatus: 'Active', projects: [{ id: 'proj4', name: 'ERP Implementation', description: 'Primary engagement workstream', startDate: '2025-09-01', endDate: '2026-06-30', hoursBudget: 546, status: 'Active' }], revenueBreakdown: [], lastModified: null },
    { id: 'c21', name: 'Lakeview Properties', complexity: 4, hoursBudget: null, revenue: 479000, market: 'Healthcare', notes: '', clientType: 'Ongoing', feeType: 'T&M', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c22', name: 'Cobalt Financial Group', complexity: 5, hoursBudget: null, revenue: 715000, market: 'Financial Services', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c23', name: 'Cornerstone Industries', complexity: 5, hoursBudget: null, revenue: 624000, market: 'Industrial', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
    { id: 'c24', name: 'Whitfield Health Systems', complexity: 5, hoursBudget: null, revenue: 581000, market: 'Healthcare', notes: '', clientType: 'Ongoing', feeType: 'Fixed Fee', endDate: null, clientStatus: 'Active', projects: [], revenueBreakdown: [], lastModified: null },
  ],
  assignments: [
    { id: 'a1', personId: 'p15', clientId: 'c22', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a2', personId: 'p19', clientId: 'c22', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a3', personId: 'p46', clientId: 'c22', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a4', personId: 'p17', clientId: 'c22', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a5', personId: 'p9', clientId: 'c22', chairPosition: 5, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a6', personId: 'p28', clientId: 'c22', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a7', personId: 'p50', clientId: 'c22', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a8', personId: 'p38', clientId: 'c22', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a9', personId: 'p47', clientId: 'c22', chairPosition: 4, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a10', personId: 'p37', clientId: 'c22', chairPosition: 5, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a11', personId: '__TBD__', clientId: 'c22', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a12', personId: '__OPEN__', clientId: 'c22', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a13', personId: 'p15', clientId: 'c23', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a14', personId: 'p2', clientId: 'c23', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a15', personId: 'p32', clientId: 'c23', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a16', personId: 'p17', clientId: 'c23', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a17', personId: 'p28', clientId: 'c23', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a18', personId: 'p47', clientId: 'c23', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a19', personId: 'p38', clientId: 'c23', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a20', personId: '__TBD__', clientId: 'c23', chairPosition: 5, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a21', personId: '__OPEN__', clientId: 'c23', chairPosition: 4, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a22', personId: 'p1', clientId: 'c24', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a23', personId: 'p46', clientId: 'c24', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a24', personId: 'p2', clientId: 'c24', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a25', personId: 'p32', clientId: 'c24', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a26', personId: 'p50', clientId: 'c24', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a27', personId: 'p45', clientId: 'c24', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a28', personId: 'p42', clientId: 'c24', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a29', personId: '__OPEN__', clientId: 'c24', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a30', personId: 'p28', clientId: 'c17', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a31', personId: 'p19', clientId: 'c17', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a32', personId: 'p1', clientId: 'c17', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a33', personId: 'p9', clientId: 'c17', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a34', personId: 'p32', clientId: 'c17', chairPosition: 5, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a35', personId: 'p49', clientId: 'c17', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a36', personId: '__TBD__', clientId: 'c17', chairPosition: 5, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a37', personId: 'p15', clientId: 'c18', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a38', personId: 'p27', clientId: 'c18', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a39', personId: 'p31', clientId: 'c18', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a40', personId: 'p18', clientId: 'c18', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a41', personId: 'p44', clientId: 'c18', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a42', personId: '__OPEN__', clientId: 'c18', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a43', personId: 'p1', clientId: 'c19', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a44', personId: 'p46', clientId: 'c19', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a45', personId: 'p35', clientId: 'c19', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a46', personId: 'p24', clientId: 'c19', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a47', personId: 'p40', clientId: 'c19', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a48', personId: 'p16', clientId: 'c19', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a49', personId: 'p43', clientId: 'c19', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a50', personId: 'p41', clientId: 'c19', chairPosition: 4, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a51', personId: 'p19', clientId: 'c20', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a52', personId: 'p11', clientId: 'c20', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a53', personId: 'p3', clientId: 'c20', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a54', personId: 'p39', clientId: 'c20', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a55', personId: 'p36', clientId: 'c20', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a56', personId: '__TBD__', clientId: 'c20', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a57', personId: 'p2', clientId: 'c21', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a58', personId: 'p17', clientId: 'c21', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a59', personId: 'p5', clientId: 'c21', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a60', personId: 'p8', clientId: 'c21', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a61', personId: 'p35', clientId: 'c21', chairPosition: 5, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a62', personId: 'p38', clientId: 'c21', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a63', personId: 'p50', clientId: 'c21', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a64', personId: 'p37', clientId: 'c21', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a65', personId: '__TBD__', clientId: 'c21', chairPosition: 5, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a66', personId: 'p24', clientId: 'c9', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a67', personId: 'p5', clientId: 'c9', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a68', personId: 'p30', clientId: 'c9', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a69', personId: 'p44', clientId: 'c9', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a70', personId: 'p36', clientId: 'c9', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a71', personId: 'p46', clientId: 'c10', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a72', personId: 'p27', clientId: 'c10', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a73', personId: 'p6', clientId: 'c10', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a74', personId: 'p49', clientId: 'c10', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a75', personId: 'p42', clientId: 'c10', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a76', personId: 'p9', clientId: 'c11', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a77', personId: 'p3', clientId: 'c11', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a78', personId: 'p25', clientId: 'c11', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a79', personId: 'p45', clientId: 'c11', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a80', personId: 'p41', clientId: 'c11', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a81', personId: 'p8', clientId: 'c12', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a82', personId: 'p30', clientId: 'c12', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a83', personId: 'p13', clientId: 'c12', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a84', personId: 'p11', clientId: 'c13', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a85', personId: 'p18', clientId: 'c13', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a86', personId: 'p26', clientId: 'c13', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a87', personId: 'p35', clientId: 'c14', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a88', personId: 'p31', clientId: 'c14', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a89', personId: 'p29', clientId: 'c14', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a90', personId: 'p18', clientId: 'c15', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a91', personId: 'p8', clientId: 'c15', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a92', personId: 'p13', clientId: 'c15', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a93', personId: 'p2', clientId: 'c16', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a94', personId: 'p5', clientId: 'c16', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a95', personId: 'p6', clientId: 'c16', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a96', personId: 'p39', clientId: 'c16', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a97', personId: 'p48', clientId: 'c16', chairPosition: 2, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a98', personId: 'p3', clientId: 'c4', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a99', personId: 'p26', clientId: 'c4', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a100', personId: 'p11', clientId: 'c5', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a101', personId: 'p29', clientId: 'c5', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a102', personId: 'p31', clientId: 'c6', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a103', personId: 'p25', clientId: 'c6', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a104', personId: 'p24', clientId: 'c7', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a105', personId: 'p6', clientId: 'c7', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a106', personId: 'p18', clientId: 'c8', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a107', personId: 'p13', clientId: 'c8', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a108', personId: 'p30', clientId: 'c1', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a109', personId: 'p27', clientId: 'c2', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a110', personId: 'p29', clientId: 'c3', chairPosition: 1, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a111', personId: 'p40', clientId: 'c9', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a112', personId: 'p43', clientId: 'c10', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a113', personId: 'p16', clientId: 'c11', chairPosition: 3, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a114', personId: 'p48', clientId: 'c12', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a115', personId: 'p40', clientId: 'c13', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a116', personId: 'p43', clientId: 'c14', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a117', personId: 'p41', clientId: 'c15', chairPosition: 1, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
    { id: 'a118', personId: '__TBD__', clientId: 'c16', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a119', personId: 'p34', clientId: 'c4', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a120', personId: 'p33', clientId: 'c5', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a121', personId: 'p4', clientId: 'c6', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a122', personId: 'p10', clientId: 'c7', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a123', personId: 'p34', clientId: 'c8', chairPosition: 3, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a124', personId: 'p7', clientId: 'c1', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a125', personId: 'p12', clientId: 'c2', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a126', personId: 'p20', clientId: 'c3', chairPosition: 2, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a127', personId: 'p14', clientId: 'c13', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a128', personId: 'p21', clientId: 'c14', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a129', personId: 'p22', clientId: 'c15', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a130', personId: 'p23', clientId: 'c12', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a131', personId: '__OPEN__', clientId: 'c20', chairPosition: 4, assignmentCohort: 'Service', hoursOverride: null, monthlyActuals: {} },
    { id: 'a132', personId: '__TBD__', clientId: 'c19', chairPosition: 5, assignmentCohort: 'Financial', hoursOverride: null, monthlyActuals: {} },
  ],
  requests: [],
  scenarios: [],
  budgetTemplates: [
    { id: 'bt1', name: 'Standard Annual Compliance', items: [
      { task: 'Planning & risk assessment', level: 2, hours: 80, notes: '' },
      { task: 'Fieldwork - senior', level: 5, hours: 200, notes: '' },
      { task: 'Fieldwork - staff', level: 6, hours: 350, notes: '' },
      { task: 'Project management', level: 4, hours: 120, notes: '' },
      { task: 'Review & sign-off', level: 1, hours: 30, notes: '' },
    ]},
    { id: 'bt2', name: 'Quarterly Reporting', items: [
      { task: 'Data gathering & prep', level: 7, hours: 160, notes: '4 quarters' },
      { task: 'Analysis & drafting', level: 5, hours: 100, notes: '' },
      { task: 'Manager review', level: 3, hours: 40, notes: '' },
    ]},
  ],
  pods: {
    'svc-east': { name: 'Service East', rootManager: 'Priya Rivera', code: 'SE2026', showCosts: true },
    'svc-west': { name: 'Service West', rootManager: 'Priya Rivera', code: 'SW2026', showCosts: true },
    'fin-ops': { name: 'Financial Ops', rootManager: 'Daniel Bell', code: 'FO2026', showCosts: false },
  },
  settings: { ...DEFAULT_SETTINGS },
  budgets: {},
  history: [],
  snapshots: [],
};

// ─── State Management ───────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      // Ensure all fields exist
      return {
        ...SAMPLE_DATA,
        ...d,
        settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
      };
    }
  } catch (e) { console.error('Load error:', e); }
  return JSON.parse(JSON.stringify(SAMPLE_DATA));
}

function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { console.error('Save error:', e); }
}

// ─── Login Screen ───────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [mode, setMode] = useState('code'); // 'code' | 'admin'
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (mode === 'admin') {
      const hash = await sha256(value);
      if (hash === ADMIN_HASH) onLogin('admin');
      else setError('Invalid password');
    } else {
      // Check pod access codes
      const data = loadData();
      const pods = data.pods || {};
      const podEntry = Object.entries(pods).find(([, p]) => p.code === value || p.code?.toLowerCase() === value.toLowerCase());
      if (podEntry) onLogin('manager', podEntry[1].name);
      else setError('Invalid access code');
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #f8f9fc 0%, #eef2ff 100%)', fontFamily: 'system-ui' }}>
      <div style={{ ...css.card, width: 400, textAlign: 'center', animation: 'fadeIn 0.3s ease' }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: 'linear-gradient(135deg, #6366f1, #818cf8)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}>📊</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1a1f36', marginBottom: 4 }}>Capacity Planner</h1>
        <p style={{ color: '#8b92a5', fontSize: 14, marginBottom: 24 }}>{mode === 'admin' ? 'Admin Access' : 'Enter your access code'}</p>
        <input
          type={mode === 'admin' ? 'password' : 'text'}
          value={value}
          onChange={e => { setValue(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          placeholder={mode === 'admin' ? 'Password' : 'Access code'}
          style={{ ...css.input, textAlign: 'center', marginBottom: 12 }}
          autoFocus
        />
        {error && <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>{error}</p>}
        <button onClick={handleSubmit} style={{ ...css.btn(), width: '100%', padding: '10px 0', marginBottom: 16 }}>Sign In</button>
        <button onClick={() => { setMode(mode === 'admin' ? 'code' : 'admin'); setValue(''); setError(''); }} style={{ background: 'none', border: 'none', color: '#6366f1', fontSize: 13, cursor: 'pointer', fontFamily: 'system-ui' }}>
          {mode === 'admin' ? '← Back to code entry' : 'Admin access →'}
        </button>
      </div>
    </div>
  );
}

// ─── Utilization Bar Component ──────────────────────────────────
function UtilBar({ util, prospectUtil = 0, target = 100, width = '100%', height = 18, showLabel = true }) {
  const green = '#22c55e', yellow = '#f59e0b', red = '#ef4444', prospect = '#818cf8';
  const clampedUtil = Math.min(util, 150);
  const clampedProspect = Math.min(prospectUtil, 150);
  const barColor = util > 110 ? red : util >= 80 ? green : yellow;

  return (
    <div style={{ width, position: 'relative' }}>
      <div style={{ height, background: '#f0f1f5', borderRadius: height / 2, overflow: 'hidden', position: 'relative' }}>
        {clampedProspect > clampedUtil && (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: (clampedProspect / 150) * 100 + '%', background: `repeating-linear-gradient(45deg, ${prospect}, ${prospect} 2px, transparent 2px, transparent 6px)`, opacity: 0.3, borderRadius: height / 2 }} />
        )}
        <div style={{ height: '100%', width: (clampedUtil / 150) * 100 + '%', background: barColor, borderRadius: height / 2, transition: 'width 0.3s ease' }} />
      </div>
      {showLabel && <span style={{ position: 'absolute', right: 4, top: 0, lineHeight: height + 'px', fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{pct(util)}</span>}
    </div>
  );
}

// ─── Notification Badge ─────────────────────────────────────────
function Badge({ count, color = '#ef4444' }) {
  if (!count) return null;
  return <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, borderRadius: 9, background: color, color: '#fff', fontSize: 11, fontWeight: 700, padding: '0 5px', marginLeft: 4 }}>{count}</span>;
}

// ─── Dashboard ──────────────────────────────────────────────────
function Dashboard({ data, onOpenDetail, onOpenGaps, onOpenPeopleSummary }) {
  const { people, clients, assignments, settings } = data;
  const activeClients = clients.filter(c => c.clientStatus !== 'Prospect');
  const prospectClients = clients.filter(c => c.clientStatus === 'Prospect');

  const totalRevenue = activeClients.reduce((s, c) => s + (c.revenue || 0), 0);
  const prospectRevenue = prospectClients.reduce((s, c) => s + (c.revenue || 0), 0);

  const personUtils = useMemo(() => people.map(p => getPersonUtil(p, assignments, clients, settings)), [people, assignments, clients, settings]);
  const avgUtil = personUtils.length > 0 ? personUtils.reduce((s, u) => s + u.util, 0) / personUtils.length : 0;
  const overTarget = personUtils.filter(u => u.util > 100).length;
  const availableCount = personUtils.filter(u => u.util < 80).length;

  const totalCost = useMemo(() => {
    return people.reduce((sum, p) => {
      const { hours } = calcPersonHours(p.id, assignments, clients, settings);
      const lv = settings.levels.find(l => l.level === p.level);
      return sum + hours * (lv ? lv.costPerHour : 150);
    }, 0);
  }, [people, assignments, clients, settings]);

  const margin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;
  const realization = calcRealization(totalCost, totalRevenue);

  const gaps = assignments.filter(a => isPlaceholder(a.personId));
  const svcCount = people.filter(p => p.cohorts.includes('Service')).length;
  const finCount = people.filter(p => p.cohorts.includes('Financial')).length;

  // Utilization distribution for chart
  const utilBuckets = [0, 0, 0, 0, 0]; // <60, 60-80, 80-100, 100-120, >120
  personUtils.forEach(u => {
    if (u.util < 60) utilBuckets[0]++;
    else if (u.util < 80) utilBuckets[1]++;
    else if (u.util < 100) utilBuckets[2]++;
    else if (u.util < 120) utilBuckets[3]++;
    else utilBuckets[4]++;
  });
  const utilLabels = ['<60%', '60-80%', '80-100%', '100-120%', '>120%'];
  const utilColors = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6'];

  // Cost by level
  const costByLevel = useMemo(() => {
    const result = {};
    settings.levels.forEach(l => { result[l.level] = 0; });
    people.forEach(p => {
      const { hours } = calcPersonHours(p.id, assignments, clients, settings);
      const lv = settings.levels.find(l => l.level === p.level);
      if (lv) result[p.level] = (result[p.level] || 0) + hours * lv.costPerHour;
    });
    return result;
  }, [people, assignments, clients, settings]);

  // Ending within 60 days
  const now = new Date();
  const endingSoon = clients.filter(c => c.endDate && (new Date(c.endDate) - now) / 86400000 <= 60 && (new Date(c.endDate) - now) / 86400000 > 0);

  const maxCost = Math.max(...Object.values(costByLevel), 1);

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      {/* Top Row: Stats + Gaps */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 14 }}>
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {/* People Card */}
          <div onClick={onOpenPeopleSummary} style={{ background: '#6366f110', border: '1px solid #6366f130', borderRadius: 9, padding: '14px 16px', textAlign: 'center', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#6366f1', fontFamily: 'SF Mono, monospace' }}>{people.length}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>People</div>
            <div style={{ fontSize: 10, color: '#8b92a5', marginTop: 3 }}>Svc {svcCount} / Fin {finCount}</div>
          </div>
          {/* Revenue Card */}
          <div style={{ background: '#05966910', border: '1px solid #05966930', borderRadius: 9, padding: '14px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#059669', fontFamily: 'SF Mono, monospace' }}>{totalRevenue > 0 ? fmtDol(totalRevenue) : '--'}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Revenue</div>
            {realization && <div style={{ fontSize: 10, color: realization.multiplier >= 1 ? '#059669' : '#ef4444', fontWeight: 600, marginTop: 4 }}>{realization.multiplier}x realization</div>}
          </div>
          {/* Est. Cost Card */}
          <div style={{ background: '#8b5cf610', border: '1px solid #8b5cf630', borderRadius: 9, padding: '14px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#8b5cf6', fontFamily: 'SF Mono, monospace' }}>{fmtDol(totalCost)}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Est. Cost</div>
            {totalRevenue > 0 && <div style={{ fontSize: 10, color: margin >= 0 ? '#059669' : '#ef4444', fontWeight: 600, marginTop: 4 }}>{fmtDol(totalRevenue - totalCost)} ({pct(margin)} margin)</div>}
          </div>
          {/* Avg Util Card */}
          <div style={{ background: '#f59e0b10', border: '1px solid #f59e0b30', borderRadius: 9, padding: '14px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#f59e0b', fontFamily: 'SF Mono, monospace' }}>{pct(avgUtil)}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', marginTop: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Avg Util</div>
            <div style={{ fontSize: 10, marginTop: 3 }}>
              <span style={{ color: '#ef4444' }}>{overTarget} over</span> · <span style={{ color: '#f59e0b' }}>{availableCount} avail</span>
            </div>
          </div>
        </div>
        {/* Staffing Gaps Box */}
        <div style={{ ...css.card, width: 260, minWidth: 220, maxHeight: 160, overflow: 'auto', flexShrink: 0 }}>
          <div onClick={onOpenGaps} style={{ fontSize: 14, fontWeight: 700, color: '#1a1f36', marginBottom: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            Staffing Gaps <Badge count={gaps.length} color="#f59e0b" />
          </div>
          {gaps.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No gaps</div> : gaps.slice(0, 6).map(g => {
            const c = clients.find(cl => cl.id === g.clientId);
            return (
              <div key={g.id} onClick={() => onOpenDetail({ type: 'client', id: g.clientId })} style={{ fontSize: 13, padding: '3px 0', cursor: 'pointer', color: '#4a5175', display: 'flex', gap: 4 }}>
                <span style={{ ...css.badge(g.personId === '__TBD__' ? '#fef3c7' : '#fee2e2', g.personId === '__TBD__' ? '#92400e' : '#dc2626'), fontSize: 11 }}>{placeholderLabel(g.personId)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c?.name} · {CHAIR_LABELS[g.chairPosition]}</span>
              </div>
            );
          })}
          {gaps.length > 6 && <div style={{ fontSize: 12, color: '#6366f1', marginTop: 4 }}>+{gaps.length - 6} more</div>}
        </div>
      </div>

      {/* Pipeline Summary Bar */}
      {prospectClients.length > 0 && (
        <div style={{ background: '#eef2ff', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: '#4338ca' }}>
          <span style={{ fontWeight: 700 }}>Pipeline:</span>
          <span>{prospectClients.length} prospect{prospectClients.length !== 1 ? 's' : ''}</span>
          <span>·</span>
          <span>{fmtDol(prospectRevenue)} potential revenue</span>
          <span>·</span>
          <span>{Math.round(personUtils.reduce((s, u) => s + u.prospectHours, 0)).toLocaleString()} hrs if won</span>
        </div>
      )}

      {/* Notification badges row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {overTarget > 0 && <span style={css.badge('#fee2e2', '#dc2626')}>⚠ {overTarget} over target</span>}
        {endingSoon.length > 0 && <span style={css.badge('#fef3c7', '#92400e')}>⏰ {endingSoon.length} ending within 60 days</span>}
        {availableCount > 0 && <span style={css.badge('#dbeafe', '#1e40af')}>📉 {availableCount} low utilization</span>}
      </div>

      {/* Charts Row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        {/* Utilization Distribution */}
        <div style={{ ...css.card, flex: '1 1 300px' }}>
          <div style={css.sectionTitle}>Utilization Distribution</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120, padding: '0 8px' }}>
            {utilBuckets.map((count, i) => (
              <div key={i} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ height: Math.max(count / Math.max(...utilBuckets, 1) * 100, 4), background: utilColors[i], borderRadius: '4px 4px 0 0', transition: 'height 0.3s ease', marginBottom: 4 }} />
                <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{count}</div>
                <div style={{ fontSize: 10, color: '#9ca3af' }}>{utilLabels[i]}</div>
              </div>
            ))}
          </div>
        </div>
        {/* Cost by Level */}
        <div style={{ ...css.card, flex: '1 1 300px' }}>
          <div style={css.sectionTitle}>Cost by Level</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {settings.levels.map(lv => (
              <div key={lv.level} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 20, fontSize: 12, fontWeight: 600, color: '#6b7280', textAlign: 'right' }}>L{lv.level}</div>
                <div style={{ flex: 1, height: 14, background: '#f0f1f5', borderRadius: 7, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: ((costByLevel[lv.level] || 0) / maxCost * 100) + '%', background: '#6366f1', borderRadius: 7, transition: 'width 0.3s ease' }} />
                </div>
                <div style={{ width: 60, fontSize: 11, color: '#6b7280', textAlign: 'right' }}>{fmtDol(costByLevel[lv.level] || 0)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Capacity by Person Table */}
      <div style={css.card}>
        <div style={css.sectionTitle}>Capacity by Person</div>
        <div style={{ overflow: 'auto', maxHeight: 500 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={css.th}>Name</th>
                <th style={css.th}>Level</th>
                <th style={css.th}>Cohort</th>
                <th style={css.th}>Pod</th>
                <th style={css.th}>Hours</th>
                <th style={css.th}>Target</th>
                <th style={{ ...css.th, minWidth: 140 }}>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {personUtils.sort((a, b) => b.util - a.util).map((u, i) => {
                const p = people[i] || people.find(pp => getPersonUtil(pp, assignments, clients, settings).hours === u.hours);
                const person = people.find(pp => {
                  const pu = getPersonUtil(pp, assignments, clients, settings);
                  return pu === u;
                }) || people[i];
                // Rebuild clean sorted mapping
                return null;
              })}
              {people.slice().sort((a, b) => {
                const ua = getPersonUtil(a, assignments, clients, settings);
                const ub = getPersonUtil(b, assignments, clients, settings);
                return ub.util - ua.util;
              }).map(p => {
                const u = getPersonUtil(p, assignments, clients, settings);
                return (
                  <tr key={p.id} onClick={() => onOpenDetail({ type: 'person', id: p.id })} style={{ cursor: 'pointer' }}>
                    <td style={css.td}><span style={{ fontWeight: 600, color: '#1a1f36' }}>{p.name}</span></td>
                    <td style={css.td}>L{p.level}</td>
                    <td style={css.td}>{p.cohorts.map(c => <span key={c} style={{ ...css.badge(COHORT_COLORS[c]?.bg || '#f0f1f5', COHORT_COLORS[c]?.fg || '#6b7280'), marginRight: 4 }}>{c}</span>)}</td>
                    <td style={css.td}><span style={{ fontSize: 13, color: '#6b7280' }}>{p.pod}</span></td>
                    <td style={css.td}><span style={{ fontFamily: 'SF Mono, monospace', fontSize: 13 }}>{Math.round(u.hours).toLocaleString()}</span></td>
                    <td style={css.td}><span style={{ fontFamily: 'SF Mono, monospace', fontSize: 13 }}>{u.target.toLocaleString()}</span></td>
                    <td style={css.td}><UtilBar util={u.util} prospectUtil={u.prospectUtil} height={14} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── People Summary Panel ───────────────────────────────────────
function PeopleSummaryPanel({ data, onClose, onOpenDetail }) {
  const { people, clients, assignments, settings } = data;
  const [marketFilter, setMarketFilter] = useState('all');
  const MARKET_THRESHOLD = 600000;

  const filteredPeople = marketFilter === 'all' ? people : people.filter(p => {
    const personClients = assignments.filter(a => a.personId === p.id).map(a => clients.find(c => c.id === a.clientId)).filter(Boolean);
    const avgRev = personClients.length > 0 ? personClients.reduce((s, c) => s + (c.revenue || 0), 0) / personClients.length : 0;
    return marketFilter === 'large' ? avgRev >= MARKET_THRESHOLD : avgRev < MARKET_THRESHOLD;
  });

  const personUtils = filteredPeople.map(p => ({ person: p, ...getPersonUtil(p, assignments, clients, settings) }));
  const avgUtil = personUtils.length > 0 ? personUtils.reduce((s, u) => s + u.util, 0) / personUtils.length : 0;
  const totalAvailHours = personUtils.reduce((s, u) => s + Math.max(u.target - u.hours, 0), 0);
  const openPositions = assignments.filter(a => a.personId === '__OPEN__').length;
  const unassigned = filteredPeople.filter(p => !assignments.some(a => a.personId === p.id)).length;

  // By level breakdown
  const byLevel = {};
  settings.levels.forEach(l => { byLevel[l.level] = { count: 0, avgUtil: 0, openings: 0 }; });
  personUtils.forEach(u => {
    if (byLevel[u.person.level]) {
      byLevel[u.person.level].count++;
      byLevel[u.person.level].avgUtil += u.util;
    }
  });
  Object.values(byLevel).forEach(v => { if (v.count > 0) v.avgUtil /= v.count; });
  assignments.filter(a => a.personId === '__OPEN__').forEach(a => {
    const [lo, hi] = CHAIR_LEVEL_MAP[a.chairPosition] || [1, 7];
    for (let l = lo; l <= hi; l++) if (byLevel[l]) byLevel[l].openings++;
  });

  // Levels in demand
  const demanded = Object.entries(byLevel).filter(([, v]) => v.openings > 0 || v.avgUtil > 100).sort(([, a], [, b]) => b.openings - a.openings);

  // Most loaded / most available
  const sorted = [...personUtils].sort((a, b) => b.util - a.util);
  const mostLoaded = sorted.slice(0, 5);
  const mostAvail = sorted.reverse().slice(0, 5);

  return (
    <div style={css.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={css.panelBox('min(850px, 95vw)')} onClick={e => e.stopPropagation()}>
      <div style={{ ...css.panelHdr, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>People Summary</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {['all', 'large', 'mid'].map(f => (
            <button key={f} onClick={() => setMarketFilter(f)} style={{ background: marketFilter === f ? '#6366f1' : '#3b4268', color: marketFilter === f ? '#fff' : '#8b92a5', border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'system-ui' }}>{f === 'all' ? 'All' : f === 'large' ? 'Large' : 'Mid'}</button>
          ))}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8b92a5', fontSize: 18, cursor: 'pointer', marginLeft: 8 }}>✕</button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {/* 5 stat cards */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'People', value: filteredPeople.length },
            { label: 'Avg Util', value: pct(avgUtil) },
            { label: 'Hrs Available', value: Math.round(totalAvailHours).toLocaleString() },
            { label: 'Open Positions', value: openPositions },
            { label: 'Unassigned', value: unassigned },
          ].map((s, i) => (
            <div key={i} style={{ ...css.card, flex: '1 1 100px', textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1f36' }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Breakdown by Level */}
        <div style={{ ...css.card, marginBottom: 20 }}>
          <div style={css.sectionTitle}>Breakdown by Level</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Level', 'Count', 'Avg Util', 'Openings'].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
            <tbody>
              {settings.levels.map(lv => (
                <tr key={lv.level}>
                  <td style={css.td}>{lv.label}</td>
                  <td style={css.td}>{byLevel[lv.level]?.count || 0}</td>
                  <td style={css.td}>{pct(byLevel[lv.level]?.avgUtil || 0)}</td>
                  <td style={css.td}>{byLevel[lv.level]?.openings > 0 ? <span style={css.badge('#fee2e2', '#dc2626')}>{byLevel[lv.level].openings}</span> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Levels in Demand */}
        {demanded.length > 0 && (
          <div style={{ ...css.card, marginBottom: 20, background: '#fffbeb', border: '1px solid #fde68a' }}>
            <div style={{ ...css.sectionTitle, color: '#92400e' }}>Levels in Demand</div>
            {demanded.map(([level, v]) => (
              <div key={level} style={{ fontSize: 13, color: '#78350f', marginBottom: 4 }}>
                L{level}: {v.openings > 0 ? `${v.openings} opening(s)` : ''} {v.avgUtil > 100 ? `Avg util ${pct(v.avgUtil)}` : ''}
              </div>
            ))}
          </div>
        )}

        {/* Most Loaded / Most Available */}
        <div style={{ display: 'flex', gap: 16 }}>
          {[{ title: 'Most Loaded', list: mostLoaded }, { title: 'Most Available', list: mostAvail }].map(({ title, list }) => (
            <div key={title} style={{ ...css.card, flex: 1 }}>
              <div style={css.sectionTitle}>{title}</div>
              {list.map(u => (
                <div key={u.person.id} onClick={() => onOpenDetail({ type: 'person', id: u.person.id })} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', cursor: 'pointer', fontSize: 13 }}>
                  <span style={{ color: '#1a1f36', fontWeight: 500 }}>{u.person.name}</span>
                  <span style={{ fontFamily: 'SF Mono, monospace', color: u.util > 100 ? '#ef4444' : u.util < 60 ? '#f59e0b' : '#22c55e' }}>{pct(u.util)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}

// ─── People Tab ─────────────────────────────────────────────────
function PeopleTab({ data, setData, onOpenDetail }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [showAdd, setShowAdd] = useState(false);

  const { people, assignments, clients, settings } = data;
  const filtered = people.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.pod?.toLowerCase().includes(search.toLowerCase()));

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'level') return a.level - b.level;
    if (sortBy === 'util') return getPersonUtil(b, assignments, clients, settings).util - getPersonUtil(a, assignments, clients, settings).util;
    return 0;
  });

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1f36' }}>People</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ ...css.input, width: 200 }} />
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={css.select}>
            <option value="name">Sort: Name</option>
            <option value="level">Sort: Level</option>
            <option value="util">Sort: Utilization</option>
          </select>
          <button onClick={() => setShowAdd(true)} style={css.btn()}>+ Add Person</button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
          <div style={{ fontSize: 16 }}>No team members yet</div>
        </div>
      ) : (
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Name', 'Level', 'Cohort', 'Type', 'Pod', 'Manager', 'Utilization'].map(h => <th key={h} style={css.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const u = getPersonUtil(p, assignments, clients, settings);
                return (
                  <tr key={p.id} onClick={() => onOpenDetail({ type: 'person', id: p.id })} style={{ cursor: 'pointer' }}>
                    <td style={css.td}><span style={{ fontWeight: 600, color: '#1a1f36' }}>{p.name}</span></td>
                    <td style={css.td}>L{p.level}</td>
                    <td style={css.td}>{p.cohorts.map(c => <span key={c} style={{ ...css.badge(COHORT_COLORS[c]?.bg, COHORT_COLORS[c]?.fg), marginRight: 4 }}>{c}</span>)}</td>
                    <td style={css.td}>{p.type}</td>
                    <td style={css.td}>{p.pod}</td>
                    <td style={css.td}><span style={{ fontSize: 13, color: '#6b7280' }}>{p.manager || '–'}</span></td>
                    <td style={{ ...css.td, minWidth: 130 }}><UtilBar util={u.util} prospectUtil={u.prospectUtil} height={14} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <PersonForm data={data} onSave={person => {
        setData(d => ({ ...d, people: [...d.people, { ...person, id: uid(), lastModified: new Date().toISOString() }] }));
        setShowAdd(false);
      }} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// ─── Person Form ────────────────────────────────────────────────
function PersonForm({ data, person, onSave, onClose }) {
  const [form, setForm] = useState(person || { name: '', cohorts: ['Service'], level: 4, targetOverride: null, manager: '', pod: '', type: 'Core', notes: '' });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal onClose={onClose} width="min(520px, 95vw)">
      <div style={{ padding: 24 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1f36', marginBottom: 16 }}>{person ? 'Edit Person' : 'Add Person'}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={css.label}>Name</div>
            <input value={form.name} onChange={e => update('name', e.target.value)} style={css.input} autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Level</div>
              <select value={form.level} onChange={e => update('level', +e.target.value)} style={{ ...css.select, width: '100%' }}>
                {data.settings.levels.map(l => <option key={l.level} value={l.level}>{l.label}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Type</div>
              <select value={form.type} onChange={e => update('type', e.target.value)} style={{ ...css.select, width: '100%' }}>
                {PERSON_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <div style={css.label}>Cohorts</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {COHORTS.map(c => (
                <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.cohorts.includes(c)} onChange={e => {
                    const next = e.target.checked ? [...form.cohorts, c] : form.cohorts.filter(x => x !== c);
                    update('cohorts', next.length > 0 ? next : ['Service']);
                  }} />
                  {c}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Pod</div>
              <input value={form.pod} onChange={e => update('pod', e.target.value)} style={css.input} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Manager</div>
              <SearchSelect options={data.people.map(p => ({ value: p.name, label: p.name }))} value={form.manager} onChange={v => update('manager', v)} placeholder="Select manager..." />
            </div>
          </div>
          <div>
            <div style={css.label}>Target Override (blank = default)</div>
            <input type="number" value={form.targetOverride || ''} onChange={e => update('targetOverride', e.target.value ? +e.target.value : null)} style={css.input} placeholder={`Default: ${data.settings.levels.find(l => l.level === form.level)?.annualTarget || ''}`} />
          </div>
          <div>
            <div style={css.label}>Notes</div>
            <textarea value={form.notes} onChange={e => update('notes', e.target.value)} style={{ ...css.input, minHeight: 60, resize: 'vertical' }} />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={css.btn('#f0f1f5', '#6b7280')}>Cancel</button>
          <button onClick={() => form.name.trim() && onSave(form)} style={css.btn()} disabled={!form.name.trim()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Person Detail Panel ────────────────────────────────────────
function PersonDetail({ data, setData, personId, onClose, onOpenDetail }) {
  const { people, clients, assignments, settings } = data;
  const person = people.find(p => p.id === personId);
  if (!person) return null;

  const [editing, setEditing] = useState(false);
  const u = getPersonUtil(person, assignments, clients, settings);
  const personAssignments = assignments.filter(a => a.personId === personId);

  // Reporting hierarchy
  const getReports = (name) => people.filter(p => p.manager === name);
  const reports = getReports(person.name);
  const managerPerson = person.manager ? people.find(p => p.name === person.manager) : null;

  // Pins for this person
  const pins = assignments.filter(a => isPlaceholder(a.personId) && (a.pins || []).some(pin => pin.personId === personId));

  // Works With
  const worksWith = useMemo(() => {
    const clientIds = personAssignments.map(a => a.clientId);
    const colleagues = {};
    assignments.filter(a => clientIds.includes(a.clientId) && a.personId !== personId && !isPlaceholder(a.personId)).forEach(a => {
      if (!colleagues[a.personId]) colleagues[a.personId] = 0;
      colleagues[a.personId]++;
    });
    return Object.entries(colleagues).sort(([, a], [, b]) => b - a).map(([id, count]) => ({ person: people.find(p => p.id === id), count })).filter(x => x.person);
  }, [personAssignments, assignments, personId, people]);

  const uColor = u.util > 110 ? '#ef4444' : u.util >= 80 ? '#22c55e' : '#f59e0b';

  return (
    <div style={css.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={css.panelBox('min(800px, 95vw)')} onClick={e => e.stopPropagation()}>
      <div style={css.panelHdr}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{person.name}</h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {person.cohorts.map(c => <span key={c} style={css.badge(COHORT_COLORS[c]?.bg, COHORT_COLORS[c]?.fg)}>{c}</span>)}
              <span style={css.badge('#3b4268', '#c7d2fe')}>L{person.level}</span>
              <span style={css.badge('#3b4268', '#c7d2fe')}>{person.type}</span>
              {person.pod && <span style={css.badge('#3b4268', '#818cf8')}>{person.pod}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Reporting hierarchy */}
            {(managerPerson || reports.length > 0) && (
              <div style={{ background: '#252b45', borderRadius: 8, padding: '6px 12px', fontSize: 12, maxWidth: 200 }}>
                {managerPerson && <div style={{ color: '#8b92a5', cursor: 'pointer' }} onClick={() => onOpenDetail({ type: 'person', id: managerPerson.id })}>↑ {managerPerson.name}</div>}
                <div style={{ fontWeight: 600, color: '#fff', marginTop: 2 }}>{person.name}</div>
                {reports.slice(0, 3).map(r => <div key={r.id} style={{ color: '#8b92a5', cursor: 'pointer', marginTop: 1 }} onClick={() => onOpenDetail({ type: 'person', id: r.id })}>↳ {r.name}</div>)}
                {reports.length > 3 && <div style={{ color: '#6b7280', marginTop: 1 }}>+{reports.length - 3} more</div>}
              </div>
            )}
            {/* Util badge */}
            <div style={{ background: uColor, color: '#fff', borderRadius: 8, padding: '6px 12px', fontWeight: 700, fontSize: 16, textAlign: 'center' }}>
              {pct(u.util)}
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8b92a5', fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
        </div>
        {/* Pin visibility */}
        {pins.length > 0 && (
          <div style={{ marginTop: 8, background: '#252b45', borderRadius: 8, padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#fde68a', fontWeight: 600 }}>📌 Pinned for {pins.length} opening{pins.length !== 1 ? 's' : ''}:</span>
            {pins.map(a => {
              const c = clients.find(cl => cl.id === a.clientId);
              const pin = (a.pins || []).find(pin => pin.personId === personId);
              return (
                <span key={a.id} onClick={() => onOpenDetail({ type: 'client', id: a.clientId })} style={{ ...css.badge('#fde68a', '#78350f'), cursor: 'pointer', fontSize: 11 }}>
                  {c?.name} · {CHAIR_LABELS[a.chairPosition]}{pin?.label ? ` · ${pin.label}` : ''}
                </span>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {/* Utilization bar */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>Utilization</span>
            <span style={{ fontSize: 13, fontFamily: 'SF Mono, monospace', color: '#6b7280' }}>{Math.round(u.hours).toLocaleString()} / {u.target.toLocaleString()} hrs</span>
          </div>
          <UtilBar util={u.util} prospectUtil={u.prospectUtil} height={20} />
        </div>

        {/* Client Assignments */}
        <div style={{ ...css.card, marginBottom: 16 }}>
          <div style={css.sectionTitle}>Client Assignments</div>
          {personAssignments.length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No assignments</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Client', 'Chair', 'Cohort', 'Hours'].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
              <tbody>
                {personAssignments.map(a => {
                  const c = clients.find(cl => cl.id === a.clientId);
                  if (!c) return null;
                  const h = a.hoursOverride || calcHours(c.complexity, a.chairPosition, settings);
                  const isProspect = c.clientStatus === 'Prospect';
                  return (
                    <tr key={a.id} onClick={() => onOpenDetail({ type: 'client', id: a.clientId })} style={{ cursor: 'pointer' }}>
                      <td style={css.td}>
                        <span style={{ fontWeight: 500, color: isProspect ? '#6366f1' : '#1a1f36', fontStyle: isProspect ? 'italic' : 'normal' }}>{c.name}</span>
                        {isProspect && <span style={{ ...css.badge('#e0e7ff', '#4338ca'), marginLeft: 6, fontSize: 10 }}>Prospect</span>}
                      </td>
                      <td style={css.td}>{CHAIR_LABELS[a.chairPosition]}</td>
                      <td style={css.td}><span style={css.badge(COHORT_COLORS[assignmentCohort(a, people)]?.bg, COHORT_COLORS[assignmentCohort(a, people)]?.fg)}>{assignmentCohort(a, people)}</span></td>
                      <td style={css.td}><span style={{ fontFamily: 'SF Mono, monospace', fontSize: 13 }}>{Math.round(h).toLocaleString()}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Works With */}
        {worksWith.length > 0 && (
          <div style={{ ...css.card, marginBottom: 16 }}>
            <div style={css.sectionTitle}>Works With</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {worksWith.map(({ person: p, count }) => (
                <span key={p.id} onClick={() => onOpenDetail({ type: 'person', id: p.id })} style={{ ...css.badge('#f0f1f5', '#4a5175'), cursor: 'pointer', fontSize: 13 }}>
                  {p.name} ({count})
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Edit Details (collapsible) */}
        <div style={css.card}>
          <div onClick={() => setEditing(!editing)} style={{ ...css.sectionTitle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
            Edit Details <span style={{ fontSize: 12, color: '#6b7280' }}>{editing ? '▼' : '▶'}</span>
          </div>
          {editing && (
            <PersonForm data={data} person={person} onSave={updated => {
              setData(d => ({ ...d, people: d.people.map(p => p.id === personId ? { ...p, ...updated, lastModified: new Date().toISOString() } : p) }));
              setEditing(false);
            }} onClose={() => setEditing(false)} />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

// ─── Clients Tab ────────────────────────────────────────────────
function ClientsTab({ data, setData, onOpenDetail }) {
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const { clients, assignments, people, settings } = data;
  const filtered = clients.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const sorted = [...filtered].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1f36' }}>Clients</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={{ ...css.input, width: 200 }} />
          <button onClick={() => setShowAdd(true)} style={css.btn()}>+ Add Client</button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 16 }}>No clients yet</div>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>{['Name', 'Complexity', 'Revenue', 'Type', 'Market', 'Team', 'Cost'].map(h => <th key={h} style={css.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {sorted.map(c => {
              const teamCount = assignments.filter(a => a.clientId === c.id).length;
              const cost = calcClientCost(c.id, assignments, people, settings, c);
              const isProspect = c.clientStatus === 'Prospect';
              const isWon = c.clientStatus === 'Won';
              return (
                <tr key={c.id} onClick={() => onOpenDetail({ type: 'client', id: c.id })} style={{ cursor: 'pointer' }}>
                  <td style={css.td}>
                    <span style={{ fontWeight: 600, color: isProspect ? '#6366f1' : '#1a1f36', fontStyle: isProspect ? 'italic' : 'normal' }}>{c.name}</span>
                    {isProspect && <span style={{ ...css.badge('#e0e7ff', '#4338ca'), marginLeft: 6, fontSize: 10 }}>Prospect</span>}
                    {isWon && <span style={{ ...css.badge('#dcfce7', '#166534'), marginLeft: 6, fontSize: 10 }}>Won</span>}
                  </td>
                  <td style={css.td}><span style={{ ...css.badge(COMPLEXITY_COLORS[c.complexity] + '20', COMPLEXITY_COLORS[c.complexity]), fontWeight: 700 }}>{c.complexity}</span></td>
                  <td style={css.td}>{fmtDol(c.revenue || 0)}</td>
                  <td style={css.td}>{c.clientType}</td>
                  <td style={css.td}>{c.market}</td>
                  <td style={css.td}>{teamCount}</td>
                  <td style={css.td}>{fmtDol(cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showAdd && <ClientForm data={data} onSave={client => {
        setData(d => ({ ...d, clients: [...d.clients, { ...client, id: uid(), projects: [], revenueBreakdown: [], lastModified: new Date().toISOString() }] }));
        setShowAdd(false);
      }} onClose={() => setShowAdd(false)} />}
    </div>
  );
}

// ─── Client Form ────────────────────────────────────────────────
function ClientForm({ data, client, onSave, onClose }) {
  const [form, setForm] = useState(client || { name: '', complexity: 3, hoursBudget: null, revenue: 0, market: '', notes: '', clientType: 'Ongoing', feeType: 'Hybrid', endDate: null, clientStatus: 'Active' });
  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal onClose={onClose} width="min(560px, 92vw)">
      <div style={{ padding: 24 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1f36', marginBottom: 16 }}>{client ? 'Edit Client' : 'Add Client'}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={css.label}>Name</div>
            <input value={form.name} onChange={e => update('name', e.target.value)} style={css.input} autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Complexity (1-5)</div>
              <select value={form.complexity} onChange={e => update('complexity', +e.target.value)} style={{ ...css.select, width: '100%' }}>
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Revenue ($)</div>
              <input type="number" value={form.revenue || ''} onChange={e => update('revenue', +e.target.value || 0)} style={css.input} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Client Type</div>
              <select value={form.clientType} onChange={e => update('clientType', e.target.value)} style={{ ...css.select, width: '100%' }}>
                <option>Ongoing</option><option>Project</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Fee Type</div>
              <select value={form.feeType} onChange={e => update('feeType', e.target.value)} style={{ ...css.select, width: '100%' }}>
                {['Retainer', 'Fixed Fee', 'T&M', 'Hybrid'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Status</div>
              <select value={form.clientStatus || 'Active'} onChange={e => update('clientStatus', e.target.value)} style={{ ...css.select, width: '100%' }}>
                <option>Active</option><option>Prospect</option><option>Won</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={css.label}>Market</div>
              <input value={form.market} onChange={e => update('market', e.target.value)} style={css.input} />
            </div>
          </div>
          {form.clientType === 'Project' && (
            <div>
              <div style={css.label}>End Date</div>
              <input type="date" value={form.endDate || ''} onChange={e => update('endDate', e.target.value || null)} style={css.input} />
            </div>
          )}
          <div>
            <div style={css.label}>Notes</div>
            <textarea value={form.notes} onChange={e => update('notes', e.target.value)} style={{ ...css.input, minHeight: 60, resize: 'vertical' }} />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={css.btn('#f0f1f5', '#6b7280')}>Cancel</button>
          <button onClick={() => form.name.trim() && onSave(form)} style={css.btn()} disabled={!form.name.trim()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Client Detail Panel ────────────────────────────────────────
function ClientDetail({ data, setData, clientId, onClose, onOpenDetail, onOpenRoster }) {
  const { clients, assignments, people, settings } = data;
  const client = clients.find(c => c.id === clientId);
  if (!client) return null;

  const [editing, setEditing] = useState(false);
  const clientAssignments = assignments.filter(a => a.clientId === clientId);
  const totalHours = calcClientHours(clientId, assignments, settings, client);
  const totalCost = calcClientCost(clientId, assignments, people, settings, client);
  const isProspect = client.clientStatus === 'Prospect';

  return (
    <div style={css.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={css.panelBox('min(900px, 95vw)')} onClick={e => e.stopPropagation()}>
      <div style={css.panelHdr}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>{client.name}</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <span style={{ ...css.badge(COMPLEXITY_COLORS[client.complexity] + '40', '#fff') }}>Complexity {client.complexity}</span>
              <span style={css.badge('#3b4268', '#c7d2fe')}>{client.clientType}</span>
              <span style={css.badge('#3b4268', '#c7d2fe')}>{client.feeType}</span>
              {client.market && <span style={css.badge('#3b4268', '#818cf8')}>{client.market}</span>}
              {isProspect && <span style={css.badge('#e0e7ff', '#4338ca')}>Prospect</span>}
              {client.clientStatus === 'Won' && <span style={css.badge('#dcfce7', '#166534')}>Won</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8b92a5', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        {/* Prospect banner */}
        {isProspect && (
          <div style={{ background: '#252b45', borderRadius: 8, padding: '8px 14px', marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#818cf8', fontSize: 12, fontWeight: 600 }}>Prospect — not included in utilization</span>
            <button onClick={() => setData(d => ({ ...d, clients: d.clients.map(c => c.id === clientId ? { ...c, clientStatus: 'Won' } : c) }))} style={css.btnSm('#22c55e', '#fff')}>Mark as Won</button>
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {/* Metrics */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          {[
            { label: 'Revenue', value: fmtDol(client.revenue || 0) },
            { label: 'Est. Cost', value: fmtDol(totalCost) },
            { label: 'Team Size', value: clientAssignments.length },
            { label: 'Total Hours', value: Math.round(totalHours).toLocaleString() },
          ].map((m, i) => (
            <div key={i} style={{ ...css.card, flex: 1, textAlign: 'center', padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{m.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#1a1f36', marginTop: 2 }}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* Status dropdown */}
        <div style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={css.label}>Status:</span>
          <select value={client.clientStatus || 'Active'} onChange={e => setData(d => ({ ...d, clients: d.clients.map(c => c.id === clientId ? { ...c, clientStatus: e.target.value } : c) }))} style={css.select}>
            <option>Active</option><option>Prospect</option><option>Won</option>
          </select>
        </div>

        {/* Team Roster */}
        <div style={{ ...css.card, marginBottom: 16 }}>
          <div style={css.sectionTitle}>Team Roster</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Person', 'Chair', 'Cohort', 'Hours', ''].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
            <tbody>
              {clientAssignments.map(a => {
                const p = people.find(pp => pp.id === a.personId);
                const h = a.hoursOverride || calcHours(client.complexity, a.chairPosition, settings);
                const isPh = isPlaceholder(a.personId);
                return (
                  <tr key={a.id}>
                    <td style={css.td}>
                      {isPh ? (
                        <span style={{ ...css.badge(a.personId === '__TBD__' ? '#fef3c7' : '#fee2e2', a.personId === '__TBD__' ? '#92400e' : '#dc2626') }}>{placeholderLabel(a.personId)}</span>
                      ) : (
                        <span onClick={() => onOpenDetail({ type: 'person', id: a.personId })} style={{ fontWeight: 500, color: '#1a1f36', cursor: 'pointer' }}>{p?.name}</span>
                      )}
                    </td>
                    <td style={css.td}>{CHAIR_LABELS[a.chairPosition]}</td>
                    <td style={css.td}><span style={css.badge(COHORT_COLORS[assignmentCohort(a, people)]?.bg, COHORT_COLORS[assignmentCohort(a, people)]?.fg)}>{assignmentCohort(a, people)}</span></td>
                    <td style={css.td}><span style={{ fontFamily: 'SF Mono, monospace', fontSize: 13 }}>{Math.round(h).toLocaleString()}</span></td>
                    <td style={css.td}>
                      {isPh && <button onClick={() => onOpenRoster && onOpenRoster({ clientId, assignmentId: a.id, chairPosition: a.chairPosition, cohort: assignmentCohort(a, people) })} style={css.btnSm('#6366f1', '#fff')}>Find</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Projects */}
        {client.projects?.length > 0 && (
          <div style={{ ...css.card, marginBottom: 16 }}>
            <div style={css.sectionTitle}>Projects</div>
            {client.projects.map(proj => (
              <div key={proj.id} style={{ padding: '8px 0', borderBottom: '1px solid #f0f1f5' }}>
                <div style={{ fontWeight: 600, color: '#1a1f36' }}>{proj.name}</div>
                <div style={{ fontSize: 13, color: '#6b7280' }}>{proj.description}</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{proj.startDate} → {proj.endDate} · {proj.hoursBudget} hrs · {proj.status}</div>
              </div>
            ))}
          </div>
        )}

        {/* Edit */}
        <div style={css.card}>
          <div onClick={() => setEditing(!editing)} style={{ ...css.sectionTitle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
            Edit Details <span style={{ fontSize: 12, color: '#6b7280' }}>{editing ? '▼' : '▶'}</span>
          </div>
          {editing && <ClientForm data={data} client={client} onSave={updated => {
            setData(d => ({ ...d, clients: d.clients.map(c => c.id === clientId ? { ...c, ...updated, lastModified: new Date().toISOString() } : c) }));
            setEditing(false);
          }} onClose={() => setEditing(false)} />}
        </div>
      </div>
      </div>
    </div>
  );
}

// ─── Staffing Gaps Panel ────────────────────────────────────────
function StaffingGapsPanel({ data, setData, onClose, onOpenDetail, onOpenRoster, onPreviewScenario }) {
  const [tab, setTab] = useState('gaps');
  const [cohortFilter, setCohortFilter] = useState('all');
  const [fullscreen, setFullscreen] = useState(false);
  const { assignments, clients, people, settings, scenarios = [], requests = [] } = data;

  const gaps = assignments.filter(a => isPlaceholder(a.personId));
  const filteredGaps = cohortFilter === 'all' ? gaps : gaps.filter(a => assignmentCohort(a, people) === cohortFilter);

  // Request form state
  const [reqForm, setReqForm] = useState({ clientId: '', chairPosition: 1, cohort: 'Service', urgency: 'Normal', requestingManager: '', reason: '', replacePerson: '', targetStartDate: '', status: 'Open' });

  return (
    <div style={css.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={fullscreen
        ? { position: 'fixed', inset: 0, background: '#fff', zIndex: 1001, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
        : css.panelBox('min(950px, 95vw)')
      } onClick={e => e.stopPropagation()}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0, background: '#1a1f36', color: '#fff', borderRadius: fullscreen ? 0 : undefined }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>Staffing Gaps</h2>
            <Badge count={gaps.length} color="#f59e0b" />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={() => setFullscreen(f => !f)} style={{ background: 'none', border: '1px solid #3b4268', color: '#8b92a5', borderRadius: 4, padding: '2px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'system-ui' }}>{fullscreen ? '⊡' : '⊞'}</button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8b92a5', fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['gaps', 'requests', 'scenarios'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? '#3b4268' : 'transparent', color: tab === t ? '#fff' : '#8b92a5', border: 'none', borderBottom: tab === t ? '2px solid #818cf8' : '2px solid transparent', padding: '8px 16px', fontSize: 12, fontWeight: tab === t ? 700 : 500, cursor: 'pointer', fontFamily: 'system-ui', textTransform: 'capitalize' }}>{t}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {tab === 'gaps' && (
          <>
            <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
              {['all', ...COHORTS].map(c => (
                <button key={c} onClick={() => setCohortFilter(c)} style={{ ...css.btnSm(cohortFilter === c ? '#6366f1' : '#f0f1f5', cohortFilter === c ? '#fff' : '#6b7280'), textTransform: 'capitalize' }}>{c}</button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {filteredGaps.map(g => {
                const c = clients.find(cl => cl.id === g.clientId);
                const cohort = assignmentCohort(g, people);
                const [idealLo, idealHi] = CHAIR_LEVEL_MAP[g.chairPosition] || [1, 7];
                const pinCount = (g.pins || []).length;
                // Recommendation: find best match
                const candidates = people.filter(p => p.level >= idealLo && p.level <= idealHi && p.cohorts.includes(cohort));
                const bestMatch = candidates.sort((a, b) => getPersonUtil(a, assignments, clients, settings).util - getPersonUtil(b, assignments, clients, settings).util)[0];

                return (
                  <div key={g.id} style={{ ...css.card, border: '1px solid #e5e7eb', padding: 16, position: 'relative' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ ...css.badge(g.personId === '__TBD__' ? '#fef3c7' : '#fee2e2', g.personId === '__TBD__' ? '#92400e' : '#dc2626') }}>{placeholderLabel(g.personId)}</span>
                      {pinCount > 0 && <span style={css.badge('#fde68a', '#78350f')}>📌 {pinCount}</span>}
                    </div>
                    <div onClick={() => onOpenDetail({ type: 'client', id: g.clientId })} style={{ fontWeight: 600, color: '#1a1f36', cursor: 'pointer', marginBottom: 4 }}>{c?.name}</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>{CHAIR_LABELS[g.chairPosition]} · {cohort} · L{idealLo}-L{idealHi}</div>
                    {bestMatch && (
                      <div style={{ fontSize: 13, color: '#059669', marginBottom: 8 }}>
                        💡 {bestMatch.name} (L{bestMatch.level}, {pct(getPersonUtil(bestMatch, assignments, clients, settings).util)} util)
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => onOpenRoster && onOpenRoster({ clientId: g.clientId, assignmentId: g.id, chairPosition: g.chairPosition, cohort })} style={css.btnSm('#6366f1', '#fff')}>Roster</button>
                      <button onClick={() => {
                        // Open gap notes
                      }} style={css.btnSm('#f0f1f5', '#6b7280')}>Notes</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {filteredGaps.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No gaps{cohortFilter !== 'all' ? ` for ${cohortFilter}` : ''}</div>}
          </>
        )}

        {tab === 'requests' && (
          <div>
            <div style={{ ...css.card, marginBottom: 16 }}>
              <div style={css.sectionTitle}>New Request</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={css.label}>Client</div>
                  <SearchSelect options={clients.map(c => ({ value: c.id, label: c.name }))} value={reqForm.clientId} onChange={v => setReqForm(f => ({ ...f, clientId: v }))} />
                </div>
                <div>
                  <div style={css.label}>Chair Position</div>
                  <select value={reqForm.chairPosition} onChange={e => setReqForm(f => ({ ...f, chairPosition: +e.target.value }))} style={{ ...css.select, width: '100%' }}>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{CHAIR_LABELS[n]}</option>)}
                  </select>
                </div>
                <div>
                  <div style={css.label}>Cohort</div>
                  <select value={reqForm.cohort} onChange={e => setReqForm(f => ({ ...f, cohort: e.target.value }))} style={{ ...css.select, width: '100%' }}>
                    {COHORTS.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <div style={css.label}>Urgency</div>
                  <select value={reqForm.urgency} onChange={e => setReqForm(f => ({ ...f, urgency: e.target.value }))} style={{ ...css.select, width: '100%' }}>
                    {['Low', 'Normal', 'High', 'Critical'].map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <div style={css.label}>Requesting Manager</div>
                  <input value={reqForm.requestingManager} onChange={e => setReqForm(f => ({ ...f, requestingManager: e.target.value }))} style={css.input} />
                </div>
                <div>
                  <div style={css.label}>Reason</div>
                  <input value={reqForm.reason} onChange={e => setReqForm(f => ({ ...f, reason: e.target.value }))} style={css.input} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={() => {
                  if (!reqForm.clientId) return;
                  const req = { ...reqForm, id: uid(), createdAt: new Date().toISOString() };
                  setData(d => ({ ...d, requests: [...(d.requests || []), req] }));
                  setReqForm({ clientId: '', chairPosition: 1, cohort: 'Service', urgency: 'Normal', requestingManager: '', reason: '', replacePerson: '', targetStartDate: '', status: 'Open' });
                }} style={css.btn()}>Submit Request</button>
                <button onClick={() => {
                  if (!reqForm.clientId) return;
                  // Convert to gap
                  const assignment = { id: uid(), personId: '__TBD__', clientId: reqForm.clientId, chairPosition: reqForm.chairPosition, assignmentCohort: reqForm.cohort, hoursOverride: null, monthlyActuals: {}, pins: [] };
                  setData(d => ({ ...d, assignments: [...d.assignments, assignment] }));
                }} style={css.btn('#f59e0b', '#fff')}>→ Gap</button>
              </div>
            </div>

            {/* Existing requests */}
            {(data.requests || []).length > 0 && (
              <div style={css.card}>
                <div style={css.sectionTitle}>Requests</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>{['Client', 'Chair', 'Cohort', 'Urgency', 'Status', ''].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {(data.requests || []).map(r => {
                      const c = clients.find(cl => cl.id === r.clientId);
                      return (
                        <tr key={r.id}>
                          <td style={css.td}>{c?.name || '–'}</td>
                          <td style={css.td}>{CHAIR_LABELS[r.chairPosition]}</td>
                          <td style={css.td}>{r.cohort}</td>
                          <td style={css.td}><span style={css.badge(r.urgency === 'Critical' ? '#fee2e2' : r.urgency === 'High' ? '#fef3c7' : '#f0f1f5', r.urgency === 'Critical' ? '#dc2626' : r.urgency === 'High' ? '#92400e' : '#6b7280')}>{r.urgency}</span></td>
                          <td style={css.td}><span style={css.badge('#dbeafe', '#1e40af')}>{r.status}</span></td>
                          <td style={css.td}>
                            <select value={r.status} onChange={e => setData(d => ({ ...d, requests: d.requests.map(rr => rr.id === r.id ? { ...rr, status: e.target.value } : rr) }))} style={{ ...css.select, fontSize: 12, padding: '2px 6px' }}>
                              {['Open', 'In Progress', 'Filled', 'Cancelled'].map(s => <option key={s}>{s}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'scenarios' && (
          <div>
            <button onClick={() => {
              // Build from current pins
              const moves = [];
              gaps.forEach(g => {
                (g.pins || []).forEach(pin => {
                  moves.push({ gapAssignmentId: g.id, personId: pin.personId, clientId: g.clientId, chairPosition: g.chairPosition, cohort: assignmentCohort(g, people), personName: people.find(p => p.id === pin.personId)?.name, clientName: clients.find(c => c.id === g.clientId)?.name });
                });
              });
              if (moves.length === 0) return;
              const name = prompt('Scenario name:');
              if (!name) return;
              setData(d => ({ ...d, scenarios: [...(d.scenarios || []), { id: uid(), name, createdAt: new Date().toISOString(), moves, status: 'Draft' }] }));
            }} style={{ ...css.btn(), marginBottom: 16 }}>Build from Current Pins</button>

            {(data.scenarios || []).map(sc => (
              <div key={sc.id} style={{ ...css.card, marginBottom: 12, border: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <span style={{ fontWeight: 700, color: '#1a1f36' }}>{sc.name}</span>
                    <span style={{ ...css.badge(sc.status === 'Applied' ? '#dcfce7' : sc.status === 'Rejected' ? '#fee2e2' : '#fef3c7', sc.status === 'Applied' ? '#166534' : sc.status === 'Rejected' ? '#dc2626' : '#92400e'), marginLeft: 8 }}>{sc.status}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => onPreviewScenario && onPreviewScenario(sc)} style={css.btnSm('#6366f1', '#fff')}>Preview</button>
                    {sc.status === 'Draft' && (
                      <>
                        <button onClick={() => {
                          setData(d => {
                            let a = [...d.assignments];
                            sc.moves.forEach(m => { a = a.map(aa => aa.id === m.gapAssignmentId && isPlaceholder(aa.personId) ? { ...aa, personId: m.personId } : aa); });
                            return { ...d, assignments: a, scenarios: d.scenarios.map(s => s.id === sc.id ? { ...s, status: 'Applied' } : s) };
                          });
                        }} style={css.btnSm('#22c55e', '#fff')}>Apply</button>
                        <button onClick={() => setData(d => ({ ...d, scenarios: d.scenarios.map(s => s.id === sc.id ? { ...s, status: 'Rejected' } : s) }))} style={css.btnSm('#ef4444', '#fff')}>Reject</button>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: '#6b7280' }}>
                  {sc.moves.map((m, i) => <div key={i}>{m.personName} → {m.clientName} ({CHAIR_LABELS[m.chairPosition]})</div>)}
                </div>
              </div>
            ))}
            {(data.scenarios || []).length === 0 && <div style={{ color: '#9ca3af', textAlign: 'center', padding: 40 }}>No scenarios yet. Pin candidates from the Roster and build a scenario.</div>}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

// ─── Recommendation Roster Modal ────────────────────────────────
function RecommendationRoster({ data, setData, context, onClose, onOpenDetail }) {
  const { clientId, assignmentId, chairPosition, cohort } = context;
  const { people, assignments, clients, settings } = data;
  const [levelFilter, setLevelFilter] = useState('ideal');
  const [cohortFilter, setCohortFilter] = useState(cohort || 'all');
  const [sort, setSort] = useState('bestMatch');
  const [previewPerson, setPreviewPerson] = useState(null);

  const client = clients.find(c => c.id === clientId);
  const assignment = assignments.find(a => a.id === assignmentId);
  const [idealLo, idealHi] = CHAIR_LEVEL_MAP[chairPosition] || [1, 7];

  const candidates = useMemo(() => {
    let list = people.filter(p => {
      if (levelFilter === 'ideal') return p.level >= idealLo && p.level <= idealHi;
      if (levelFilter === 'adjacent') return p.level >= idealLo - 1 && p.level <= idealHi + 1;
      return true;
    });
    if (cohortFilter !== 'all') list = list.filter(p => p.cohorts.includes(cohortFilter));

    return list.map(p => {
      const u = getPersonUtil(p, assignments, clients, settings);
      const levelMatch = (p.level >= idealLo && p.level <= idealHi) ? 2 : (p.level >= idealLo - 1 && p.level <= idealHi + 1) ? 1 : 0;
      const score = (2 - levelMatch) * 100 + u.util;
      return { person: p, ...u, score, levelMatch };
    });
  }, [people, assignments, clients, settings, levelFilter, cohortFilter, idealLo, idealHi]);

  const sorted = [...candidates].sort((a, b) => {
    if (sort === 'bestMatch') return a.score - b.score;
    if (sort === 'lowestUtil') return a.util - b.util;
    if (sort === 'level') return a.person.level - b.person.level;
    return a.person.name.localeCompare(b.person.name);
  });

  const isPinned = (personId) => (assignment?.pins || []).some(pin => pin.personId === personId);

  if (previewPerson) {
    const p = people.find(pp => pp.id === previewPerson);
    if (p) {
      const u = getPersonUtil(p, assignments, clients, settings);
      const pAssignments = assignments.filter(a => a.personId === p.id);
      return (
        <Modal onClose={onClose} width="min(800px, 95vw)" height="min(85vh, 700px)">
          <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
            <button onClick={() => setPreviewPerson(null)} style={{ ...css.btnSm('#f0f1f5', '#6b7280'), marginBottom: 16 }}>← Back to Roster</button>
            <h3 style={{ fontSize: 20, fontWeight: 700, color: '#1a1f36', marginBottom: 8 }}>{p.name}</h3>
            <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
              {p.cohorts.map(c => <span key={c} style={css.badge(COHORT_COLORS[c]?.bg, COHORT_COLORS[c]?.fg)}>{c}</span>)}
              <span style={css.badge('#f0f1f5', '#6b7280')}>L{p.level}</span>
            </div>
            <div style={{ marginBottom: 16 }}>
              <UtilBar util={u.util} prospectUtil={u.prospectUtil} height={20} />
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{Math.round(u.hours).toLocaleString()} / {u.target.toLocaleString()} hrs</div>
            </div>
            <div style={css.sectionTitle}>Current Assignments</div>
            {pAssignments.map(a => {
              const c = clients.find(cl => cl.id === a.clientId);
              return c ? <div key={a.id} style={{ fontSize: 13, padding: '4px 0', color: '#4a5175' }}>{c.name} · {CHAIR_LABELS[a.chairPosition]} · {assignmentCohort(a, people)}</div> : null;
            })}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => {
                if (!isPinned(p.id)) {
                  setData(d => ({ ...d, assignments: d.assignments.map(a => a.id === assignmentId ? { ...a, pins: [...(a.pins || []), { id: uid(), personId: p.id, label: '', createdAt: new Date().toISOString() }] } : a) }));
                }
                setPreviewPerson(null);
              }} style={css.btn(isPinned(p.id) ? '#9ca3af' : '#f59e0b', '#fff')}>{isPinned(p.id) ? 'Already Pinned' : '📌 Pin'}</button>
              <button onClick={() => {
                setData(d => ({ ...d, assignments: d.assignments.map(a => a.id === assignmentId ? { ...a, personId: p.id } : a) }));
                onClose();
              }} style={css.btn()}>Assign</button>
            </div>
          </div>
        </Modal>
      );
    }
  }

  return (
    <Modal onClose={onClose} width="min(950px, 95vw)" height="min(85vh, 700px)">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '16px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1f36' }}>Recommendation Roster</h3>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{client?.name} · {CHAIR_LABELS[chairPosition]} · {cohort}</div>
            </div>
            <button onClick={onClose} style={css.btnSm('#f0f1f5', '#6b7280')}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <select value={levelFilter} onChange={e => setLevelFilter(e.target.value)} style={css.select}>
              <option value="ideal">Ideal Level (L{idealLo}-L{idealHi})</option>
              <option value="adjacent">Adjacent</option>
              <option value="all">All Levels</option>
            </select>
            <select value={cohortFilter} onChange={e => setCohortFilter(e.target.value)} style={css.select}>
              <option value="all">All Cohorts</option>
              {COHORTS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={sort} onChange={e => setSort(e.target.value)} style={css.select}>
              <option value="bestMatch">Best Match</option>
              <option value="lowestUtil">Lowest Util</option>
              <option value="level">Level</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 24px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Name', 'Level', 'Cohort', 'Utilization', 'Pod', ''].map(h => <th key={h} style={css.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {sorted.map(c => (
                <tr key={c.person.id}>
                  <td style={css.td}><span onClick={() => setPreviewPerson(c.person.id)} style={{ fontWeight: 500, color: '#1a1f36', cursor: 'pointer' }}>{c.person.name}</span></td>
                  <td style={css.td}>
                    <span style={{ fontWeight: 600 }}>L{c.person.level}</span>
                    {c.levelMatch === 2 && <span style={{ ...css.badge('#dcfce7', '#166534'), marginLeft: 4, fontSize: 10 }}>Ideal</span>}
                  </td>
                  <td style={css.td}>{c.person.cohorts.map(co => <span key={co} style={{ ...css.badge(COHORT_COLORS[co]?.bg, COHORT_COLORS[co]?.fg), marginRight: 4 }}>{co}</span>)}</td>
                  <td style={{ ...css.td, minWidth: 120 }}><UtilBar util={c.util} height={14} /></td>
                  <td style={css.td}>{c.person.pod}</td>
                  <td style={css.td}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => {
                        if (!isPinned(c.person.id)) {
                          setData(d => ({ ...d, assignments: d.assignments.map(a => a.id === assignmentId ? { ...a, pins: [...(a.pins || []), { id: uid(), personId: c.person.id, label: '', createdAt: new Date().toISOString() }] } : a) }));
                        }
                      }} style={css.btnSm(isPinned(c.person.id) ? '#9ca3af' : '#f59e0b', '#fff')}>{isPinned(c.person.id) ? '✓' : '📌'}</button>
                      <button onClick={() => {
                        setData(d => ({ ...d, assignments: d.assignments.map(a => a.id === assignmentId ? { ...a, personId: c.person.id } : a) }));
                        onClose();
                      }} style={css.btnSm('#6366f1', '#fff')}>Assign</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No candidates match filters</div>}
        </div>
        {/* Pinned candidates bar */}
        {assignment && (assignment.pins || []).length > 0 && (
          <div style={{ padding: '12px 24px', borderTop: '1px solid #e5e7eb', background: '#fffbeb', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>📌 Pinned:</span>
            {(assignment.pins || []).map(pin => {
              const p = people.find(pp => pp.id === pin.personId);
              return <span key={pin.id} style={{ ...css.badge('#fde68a', '#78350f'), fontSize: 12 }}>{p?.name || 'Unknown'}</span>;
            })}
            <button onClick={() => {
              // Save as scenario
              const moves = (assignment.pins || []).map(pin => ({
                gapAssignmentId: assignmentId,
                personId: pin.personId,
                clientId,
                chairPosition,
                cohort,
                personName: people.find(p => p.id === pin.personId)?.name,
                clientName: client?.name,
              }));
              const name = prompt('Scenario name:');
              if (name && moves.length > 0) {
                setData(d => ({ ...d, scenarios: [...(d.scenarios || []), { id: uid(), name, createdAt: new Date().toISOString(), moves, status: 'Draft' }] }));
              }
            }} style={css.btnSm('#6366f1', '#fff')}>Save as Scenario</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Gap Notes Modal ────────────────────────────────────────────
function GapNotesModal({ data, setData, assignmentId, onClose }) {
  const assignment = data.assignments.find(a => a.id === assignmentId);
  if (!assignment) return null;

  const client = data.clients.find(c => c.id === assignment.clientId);
  const [notes, setNotes] = useState(assignment.gapNotes || '');

  useEffect(() => {
    const timer = setTimeout(() => {
      setData(d => ({ ...d, assignments: d.assignments.map(a => a.id === assignmentId ? { ...a, gapNotes: notes } : a) }));
    }, 500);
    return () => clearTimeout(timer);
  }, [notes, assignmentId]);

  return (
    <Modal onClose={onClose} width="min(760px, 95vw)" height="min(85vh, 700px)">
      <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1f36' }}>Gap Notes</h3>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <span style={css.badge(assignment.personId === '__TBD__' ? '#fef3c7' : '#fee2e2', assignment.personId === '__TBD__' ? '#92400e' : '#dc2626')}>{placeholderLabel(assignment.personId)}</span>
              <span style={{ fontSize: 13, color: '#6b7280' }}>{client?.name} · {CHAIR_LABELS[assignment.chairPosition]} · {assignmentCohort(assignment, data.people)}</span>
            </div>
          </div>
          <button onClick={onClose} style={css.btnSm('#f0f1f5', '#6b7280')}>✕</button>
        </div>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Add notes about this gap..."
          style={{ ...css.input, flex: 1, resize: 'none', fontSize: 14, lineHeight: 1.6 }}
          autoFocus
        />
        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>Auto-saving</div>
      </div>
    </Modal>
  );
}

// ─── Sandbox / What-If Bar ──────────────────────────────────────
function SandboxBar({ liveData, sandboxData, originalData, scenarioName, onDiscard, onApply, onOpenDetail }) {
  const changes = useMemo(() => {
    const diffs = [];
    const origAssignments = originalData.assignments;
    const sbAssignments = sandboxData.assignments;

    // Find filled gaps
    origAssignments.forEach(oa => {
      if (isPlaceholder(oa.personId)) {
        const sa = sbAssignments.find(a => a.id === oa.id);
        if (sa && !isPlaceholder(sa.personId)) {
          const person = sandboxData.people.find(p => p.id === sa.personId);
          const client = sandboxData.clients.find(c => c.id === sa.clientId);
          diffs.push({ type: 'filled', label: `${person?.name} → ${client?.name} (${CHAIR_LABELS[sa.chairPosition]})`, personId: sa.personId, clientId: sa.clientId });
        }
      }
    });

    // New assignments
    sbAssignments.filter(sa => !origAssignments.find(oa => oa.id === sa.id)).forEach(sa => {
      const person = sandboxData.people.find(p => p.id === sa.personId);
      const client = sandboxData.clients.find(c => c.id === sa.clientId);
      if (person && client) diffs.push({ type: 'added', label: `+ ${person.name} → ${client.name}`, personId: sa.personId, clientId: sa.clientId });
    });

    // Removed assignments
    origAssignments.filter(oa => !sbAssignments.find(sa => sa.id === oa.id) && !isPlaceholder(oa.personId)).forEach(oa => {
      const person = originalData.people.find(p => p.id === oa.personId);
      const client = originalData.clients.find(c => c.id === oa.clientId);
      if (person && client) diffs.push({ type: 'removed', label: `${person.name} ✕ ${client.name}`, personId: oa.personId, clientId: oa.clientId });
    });

    // New people
    sandboxData.people.filter(sp => !originalData.people.find(op => op.id === sp.id)).forEach(sp => {
      diffs.push({ type: 'personAdded', label: `+ ${sp.name}`, personId: sp.id });
    });

    // Removed people
    originalData.people.filter(op => !sandboxData.people.find(sp => sp.id === op.id)).forEach(op => {
      diffs.push({ type: 'personRemoved', label: `- ${op.name}`, personId: op.id });
    });

    return diffs;
  }, [originalData, sandboxData]);

  // Aggregate deltas
  const origUtils = originalData.people.map(p => getPersonUtil(p, originalData.assignments, originalData.clients, originalData.settings));
  const sbUtils = sandboxData.people.map(p => getPersonUtil(p, sandboxData.assignments, sandboxData.clients, sandboxData.settings));
  const avgOrigUtil = origUtils.length > 0 ? origUtils.reduce((s, u) => s + u.util, 0) / origUtils.length : 0;
  const avgSbUtil = sbUtils.length > 0 ? sbUtils.reduce((s, u) => s + u.util, 0) / sbUtils.length : 0;
  const utilDelta = avgSbUtil - avgOrigUtil;

  const chipColors = { filled: { bg: '#fef3c7', fg: '#92400e' }, added: { bg: '#dcfce7', fg: '#166534' }, removed: { bg: '#fee2e2', fg: '#dc2626' }, personAdded: { bg: '#dcfce7', fg: '#166534' }, personRemoved: { bg: '#fee2e2', fg: '#dc2626' } };

  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: '#1a1f36', color: '#fff', padding: '10px 24px', zIndex: 1060, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 700, fontSize: 14, color: '#818cf8' }}>
        {scenarioName ? `Preview: ${scenarioName}` : '🧪 Sandbox'}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
        {changes.map((c, i) => (
          <span key={i} onClick={() => {
            if (c.personId) onOpenDetail({ type: 'person', id: c.personId });
            else if (c.clientId) onOpenDetail({ type: 'client', id: c.clientId });
          }} style={{ ...css.badge(chipColors[c.type]?.bg || '#f0f1f5', chipColors[c.type]?.fg || '#6b7280'), cursor: 'pointer', fontSize: 12, textDecoration: c.type === 'removed' || c.type === 'personRemoved' ? 'line-through' : 'none' }}>
            {c.label}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <span>Util: {utilDelta >= 0 ? '+' : ''}{utilDelta.toFixed(1)}%</span>
        <button onClick={onApply} style={css.btnSm('#22c55e', '#fff')}>Apply</button>
        <button onClick={onDiscard} style={css.btnSm('#ef4444', '#fff')}>Discard</button>
      </div>
    </div>
  );
}

// ─── Global Search ──────────────────────────────────────────────
function GlobalSearch({ data, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const ref = useRef(null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const r = [];
    data.people.forEach(p => { if (p.name.toLowerCase().includes(q)) r.push({ type: 'person', id: p.id, name: p.name, sub: `L${p.level} · ${p.cohorts.join(', ')}` }); });
    data.clients.forEach(c => { if (c.name.toLowerCase().includes(q)) r.push({ type: 'client', id: c.id, name: c.name, sub: `Complexity ${c.complexity} · ${fmtDol(c.revenue || 0)}` }); });
    data.clients.forEach(c => (c.projects || []).forEach(proj => { if (proj.name.toLowerCase().includes(q)) r.push({ type: 'client', id: c.id, name: proj.name, sub: `Project · ${c.name}` }); }));
    return r.slice(0, 12);
  }, [query, data]);

  useEffect(() => {
    ref.current?.focus();
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') setSelectedIdx(i => Math.min(i + 1, results.length - 1));
      if (e.key === 'ArrowUp') setSelectedIdx(i => Math.max(i - 1, 0));
      if (e.key === 'Enter' && results[selectedIdx]) { onSelect(results[selectedIdx]); onClose(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [results, selectedIdx]);

  return (
    <div style={css.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ position: 'fixed', top: '20%', left: '50%', transform: 'translateX(-50%)', width: 'min(560px, 90vw)', background: '#fff', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', overflow: 'hidden', animation: 'fadeIn 0.15s ease' }}>
        <div style={{ padding: 16, borderBottom: '1px solid #e5e7eb' }}>
          <input ref={ref} value={query} onChange={e => { setQuery(e.target.value); setSelectedIdx(0); }} placeholder="Search people, clients, projects..." style={{ ...css.input, border: 'none', fontSize: 16, padding: 0 }} />
        </div>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {results.map((r, i) => (
            <div key={`${r.type}-${r.id}-${i}`} onClick={() => { onSelect(r); onClose(); }} style={{ padding: '10px 16px', cursor: 'pointer', background: i === selectedIdx ? '#eef2ff' : 'transparent', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 500, color: '#1a1f36' }}>{r.name}</div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>{r.sub}</div>
              </div>
              <span style={{ ...css.badge('#f0f1f5', '#6b7280'), fontSize: 10, textTransform: 'capitalize' }}>{r.type}</span>
            </div>
          ))}
          {query.trim() && results.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No results</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Data Tab ───────────────────────────────────────────────────
function DataTab({ data, setData }) {
  const [importText, setImportText] = useState('');

  const exportCSV = (type) => {
    let csv = '';
    if (type === 'people') {
      csv = 'id,name,cohorts,level,type,pod,manager\n';
      data.people.forEach(p => { csv += `${p.id},"${p.name}","${p.cohorts.join(';')}",${p.level},${p.type},"${p.pod || ''}","${p.manager || ''}"\n`; });
    } else if (type === 'clients') {
      csv = 'id,name,complexity,revenue,clientType,feeType,market,clientStatus\n';
      data.clients.forEach(c => { csv += `${c.id},"${c.name}",${c.complexity},${c.revenue || 0},${c.clientType},${c.feeType || ''},"${c.market || ''}",${c.clientStatus || 'Active'}\n`; });
    } else if (type === 'assignments') {
      csv = 'id,personId,clientId,chairPosition,assignmentCohort,hoursOverride\n';
      data.assignments.forEach(a => { csv += `${a.id},${a.personId},${a.clientId},${a.chairPosition},${a.assignmentCohort || ''},${a.hoursOverride || ''}\n`; });
    }
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${type}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const createSnapshot = () => {
    const snapshot = { id: uid(), name: `Snapshot ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), data: JSON.parse(JSON.stringify({ people: data.people, clients: data.clients, assignments: data.assignments })) };
    setData(d => ({ ...d, snapshots: [...(d.snapshots || []), snapshot] }));
  };

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1f36', marginBottom: 16 }}>Data Management</h2>

      {/* Export */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={css.sectionTitle}>Export CSV</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => exportCSV('people')} style={css.btn()}>People</button>
          <button onClick={() => exportCSV('clients')} style={css.btn()}>Clients</button>
          <button onClick={() => exportCSV('assignments')} style={css.btn()}>Assignments</button>
        </div>
      </div>

      {/* Import */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={css.sectionTitle}>Import CSV</div>
        <textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder="Paste CSV here..." style={{ ...css.input, minHeight: 100, marginBottom: 8, resize: 'vertical', fontFamily: 'SF Mono, monospace', fontSize: 12 }} />
        <button onClick={() => {
          if (!importText.trim()) return;
          // Basic CSV parsing
          try {
            const lines = importText.trim().split('\n');
            const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
            if (headers.includes('cohorts')) {
              // People import
              const imported = lines.slice(1).map(line => {
                const vals = line.match(/(".*?"|[^,]*)/g).map(v => v.replace(/^"|"$/g, '').trim());
                return { id: vals[0] || uid(), name: vals[1], cohorts: (vals[2] || 'Service').split(';'), level: +vals[3] || 4, type: vals[4] || 'Core', pod: vals[5] || '', manager: vals[6] || '', targetOverride: null, notes: '', lastModified: new Date().toISOString() };
              });
              setData(d => ({ ...d, people: [...d.people, ...imported] }));
            }
            setImportText('');
          } catch (e) { alert('Parse error: ' + e.message); }
        }} style={css.btn()}>Import</button>
      </div>

      {/* Snapshots */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={css.sectionTitle}>Snapshots</div>
          <button onClick={createSnapshot} style={css.btn()}>Create Snapshot</button>
        </div>
        {(data.snapshots || []).length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No snapshots yet</div> : (
          (data.snapshots || []).map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f0f1f5' }}>
              <div>
                <div style={{ fontWeight: 500, color: '#1a1f36' }}>{s.name}</div>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>{new Date(s.createdAt).toLocaleString()}</div>
              </div>
              <button onClick={() => {
                if (confirm('Restore this snapshot? Current data will be replaced.')) {
                  setData(d => ({ ...d, ...s.data }));
                }
              }} style={css.btnSm('#f59e0b', '#fff')}>Restore</button>
            </div>
          ))
        )}
      </div>

      {/* Change History */}
      <div style={css.card}>
        <div style={css.sectionTitle}>Change History</div>
        {(data.history || []).length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No changes recorded</div> : (
          (data.history || []).slice(-20).reverse().map((h, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #f0f1f5', fontSize: 13, color: '#4a5175' }}>
              <span style={{ color: '#9ca3af', marginRight: 8 }}>{new Date(h.timestamp).toLocaleString()}</span>
              {h.description}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Settings Tab ───────────────────────────────────────────────
function SettingsTab({ data, setData }) {
  const { settings, pods = [] } = data;

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1a1f36', marginBottom: 16 }}>Settings</h2>

      {/* Levels */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={css.sectionTitle}>Levels</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Level', 'Label', 'Annual Target', 'Cost/Hr'].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
          <tbody>
            {settings.levels.map((lv, i) => (
              <tr key={lv.level}>
                <td style={css.td}>L{lv.level}</td>
                <td style={css.td}><input value={lv.label} onChange={e => {
                  const levels = [...settings.levels];
                  levels[i] = { ...levels[i], label: e.target.value };
                  setData(d => ({ ...d, settings: { ...d.settings, levels } }));
                }} style={{ ...css.input, width: 200 }} /></td>
                <td style={css.td}><input type="number" value={lv.annualTarget} onChange={e => {
                  const levels = [...settings.levels];
                  levels[i] = { ...levels[i], annualTarget: +e.target.value };
                  setData(d => ({ ...d, settings: { ...d.settings, levels } }));
                }} style={{ ...css.input, width: 100 }} /></td>
                <td style={css.td}><input type="number" value={lv.costPerHour} onChange={e => {
                  const levels = [...settings.levels];
                  levels[i] = { ...levels[i], costPerHour: +e.target.value };
                  setData(d => ({ ...d, settings: { ...d.settings, levels } }));
                }} style={{ ...css.input, width: 80 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Chair Weights */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={css.sectionTitle}>Chair Weights</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {[1, 2, 3, 4, 5].map(n => (
            <div key={n}>
              <div style={css.label}>{CHAIR_LABELS[n]}</div>
              <input type="number" step="0.05" value={settings.chairWeights[n]} onChange={e => {
                setData(d => ({ ...d, settings: { ...d.settings, chairWeights: { ...d.settings.chairWeights, [n]: +e.target.value } } }));
              }} style={{ ...css.input, width: 80 }} />
            </div>
          ))}
        </div>
      </div>

      {/* Thresholds */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={css.sectionTitle}>Thresholds</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div>
            <div style={css.label}>Green (%)</div>
            <input type="number" value={settings.thresholds.green} onChange={e => setData(d => ({ ...d, settings: { ...d.settings, thresholds: { ...d.settings.thresholds, green: +e.target.value } } }))} style={{ ...css.input, width: 80 }} />
          </div>
          <div>
            <div style={css.label}>Yellow (%)</div>
            <input type="number" value={settings.thresholds.yellow} onChange={e => setData(d => ({ ...d, settings: { ...d.settings, thresholds: { ...d.settings.thresholds, yellow: +e.target.value } } }))} style={{ ...css.input, width: 80 }} />
          </div>
          <div>
            <div style={css.label}>Base Hours/Complexity</div>
            <input type="number" value={settings.baseHoursPerComplexity} onChange={e => setData(d => ({ ...d, settings: { ...d.settings, baseHoursPerComplexity: +e.target.value } }))} style={{ ...css.input, width: 100 }} />
          </div>
        </div>
      </div>

      {/* Pods */}
      <div style={{ ...css.card, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={css.sectionTitle}>Pods</div>
          <button onClick={() => {
            const key = 'pod-' + uid();
            setData(d => ({ ...d, pods: { ...(d.pods || {}), [key]: { name: '', rootManager: '', code: '', showCosts: true } } }));
          }} style={css.btnSm()}>+ Add Pod</button>
        </div>
        {Object.entries(data.pods || {}).map(([key, pod]) => (
          <div key={key} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <input value={pod.name} onChange={e => {
              setData(d => ({ ...d, pods: { ...d.pods, [key]: { ...d.pods[key], name: e.target.value } } }));
            }} placeholder="Name" style={{ ...css.input, flex: 1 }} />
            <input value={pod.code} onChange={e => {
              setData(d => ({ ...d, pods: { ...d.pods, [key]: { ...d.pods[key], code: e.target.value } } }));
            }} placeholder="Access code" style={{ ...css.input, width: 120 }} />
            <input value={pod.rootManager || ''} onChange={e => {
              setData(d => ({ ...d, pods: { ...d.pods, [key]: { ...d.pods[key], rootManager: e.target.value } } }));
            }} placeholder="Root manager" style={{ ...css.input, width: 140 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={pod.showCosts !== false} onChange={e => {
                setData(d => ({ ...d, pods: { ...d.pods, [key]: { ...d.pods[key], showCosts: e.target.checked } } }));
              }} />
              Costs
            </label>
            <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>?pod={pod.code}</span>
          </div>
        ))}
      </div>

      {/* Budget Templates */}
      <div style={css.card}>
        <div style={css.sectionTitle}>Budget Templates</div>
        {(data.budgetTemplates || []).map(bt => (
          <div key={bt.id} style={{ marginBottom: 12, padding: '8px 0', borderBottom: '1px solid #f0f1f5' }}>
            <div style={{ fontWeight: 600, color: '#1a1f36' }}>{bt.name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {bt.items.length} items · {bt.items.reduce((s, i) => s + i.hours, 0)} total hours
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Budget Worksheet Modal ─────────────────────────────────────
function BudgetWorksheet({ client, budget, settings, assignments, people, onSave, onClose, budgetTemplates }) {
  const [items, setItems] = useState(budget?.items || []);

  const totalHours = items.reduce((s, i) => s + (i.hours || 0), 0);
  const totalCost = items.reduce((s, i) => {
    const lv = settings.levels.find(l => l.level === i.level);
    return s + (i.hours || 0) * (lv?.costPerHour || 150);
  }, 0);

  return (
    <Modal onClose={onClose} width="min(850px, 95vw)">
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1f36' }}>Budget Worksheet — {client.name}</h3>
          <button onClick={onClose} style={css.btnSm('#f0f1f5', '#6b7280')}>✕</button>
        </div>

        {budgetTemplates?.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <select onChange={e => {
              const tpl = budgetTemplates.find(t => t.id === e.target.value);
              if (tpl) setItems(tpl.items.map(i => ({ ...i, id: uid() })));
            }} style={css.select} defaultValue="">
              <option value="" disabled>Load template...</option>
              {budgetTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
          <thead><tr>{['Task', 'Level', 'Hours', 'Rate', 'Cost', ''].map(h => <th key={h} style={css.th}>{h}</th>)}</tr></thead>
          <tbody>
            {items.map((item, i) => {
              const lv = settings.levels.find(l => l.level === item.level);
              const cost = (item.hours || 0) * (lv?.costPerHour || 150);
              return (
                <tr key={item.id || i}>
                  <td style={css.td}><input value={item.task} onChange={e => { const a = [...items]; a[i] = { ...a[i], task: e.target.value }; setItems(a); }} style={{ ...css.input, width: '100%' }} /></td>
                  <td style={css.td}><select value={item.level} onChange={e => { const a = [...items]; a[i] = { ...a[i], level: +e.target.value }; setItems(a); }} style={css.select}>
                    {settings.levels.map(l => <option key={l.level} value={l.level}>L{l.level}</option>)}
                  </select></td>
                  <td style={css.td}><input type="number" value={item.hours} onChange={e => { const a = [...items]; a[i] = { ...a[i], hours: +e.target.value }; setItems(a); }} style={{ ...css.input, width: 80 }} /></td>
                  <td style={css.td}>${lv?.costPerHour || 150}/hr</td>
                  <td style={css.td}>{fmtDol(cost)}</td>
                  <td style={css.td}><button onClick={() => setItems(items.filter((_, j) => j !== i))} style={{ ...css.btnSm('#fee2e2', '#dc2626'), fontSize: 11 }}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700 }}>
              <td style={css.td}>Total</td>
              <td style={css.td}></td>
              <td style={css.td}>{totalHours}</td>
              <td style={css.td}></td>
              <td style={css.td}>{fmtDol(totalCost)}</td>
              <td style={css.td}></td>
            </tr>
          </tfoot>
        </table>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setItems([...items, { id: uid(), task: '', level: 4, hours: 0, notes: '' }])} style={css.btn('#f0f1f5', '#6b7280')}>+ Add Row</button>
          <button onClick={() => onSave(client.id, { items })} style={css.btn()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Empty Welcome Dashboard ────────────────────────────────────
function WelcomeDashboard({ onLoadSample }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 40 }}>
      <div style={{ textAlign: 'center', maxWidth: 500 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: '#1a1f36', marginBottom: 8 }}>Welcome to Capacity Planner</h2>
        <p style={{ color: '#6b7280', marginBottom: 24 }}>Get started in 3 easy steps:</p>
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginBottom: 24 }}>
          {[
            { step: '1', title: 'Add People', desc: 'Build your team roster' },
            { step: '2', title: 'Add Clients', desc: 'Set up your client list' },
            { step: '3', title: 'Assign Work', desc: 'Map people to clients' },
          ].map(s => (
            <div key={s.step} style={{ ...css.card, width: 140, textAlign: 'center', padding: 16 }}>
              <div style={{ width: 32, height: 32, borderRadius: 16, background: '#6366f1', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px', fontWeight: 700 }}>{s.step}</div>
              <div style={{ fontWeight: 600, color: '#1a1f36', marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>{s.desc}</div>
            </div>
          ))}
        </div>
        <button onClick={onLoadSample} style={css.btn()}>Load Sample Data</button>
      </div>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────────
export function App() {
  useEffect(() => { injectCSS(); }, []);

  const [role, setRole] = useState(null); // null | 'admin' | 'manager'
  const [podFilter, setPodFilter] = useState(null);
  const [data, setDataRaw] = useState(loadData);
  const [tab, setTab] = useState('dashboard');
  const [detailPanel, setDetailPanel] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showGaps, setShowGaps] = useState(false);
  const [showPeopleSummary, setShowPeopleSummary] = useState(false);
  const [rosterContext, setRosterContext] = useState(null);
  const [gapNotesId, setGapNotesId] = useState(null);
  const [budgetModal, setBudgetModal] = useState(null);

  // Sandbox state
  const [sandbox, setSandbox] = useState(false);
  const [sandboxData, setSandboxData] = useState(null);
  const [originalData, setOriginalData] = useState(null);
  const [scenarioPreview, setScenarioPreview] = useState(null);

  const setData = (fn) => {
    if (sandbox) {
      setSandboxData(d => typeof fn === 'function' ? fn(d) : fn);
    } else {
      setDataRaw(d => {
        const next = typeof fn === 'function' ? fn(d) : fn;
        saveData(next);
        return next;
      });
    }
  };

  const activeData = sandbox ? sandboxData : data;

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.key === '/' || (e.metaKey && e.key === 'k')) && !e.target.matches('input, textarea, select')) {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const openDetail = (detail) => {
    setShowGaps(false);
    setShowPeopleSummary(false);
    setDetailPanel(detail);
  };

  const enterSandbox = () => {
    setOriginalData(JSON.parse(JSON.stringify(data)));
    setSandboxData(JSON.parse(JSON.stringify(data)));
    setSandbox(true);
  };

  const exitSandbox = (apply) => {
    if (apply && sandboxData) {
      setDataRaw(d => {
        saveData(sandboxData);
        return sandboxData;
      });
    }
    setSandbox(false);
    setSandboxData(null);
    setOriginalData(null);
    setScenarioPreview(null);
  };

  if (!role) {
    return <LoginScreen onLogin={(r, pod) => { setRole(r); if (pod) setPodFilter(pod); }} />;
  }

  const TABS = role === 'admin' ? ['dashboard', 'clients', 'people', 'data', 'settings'] : ['dashboard', 'clients', 'people'];

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui', background: '#f8f9fc' }}>
      {/* Top Nav */}
      <div style={{ background: '#1a1f36', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 52, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>📊 Capacity Planner</span>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto' }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? '#3b4268' : 'transparent', color: tab === t ? '#fff' : '#8b92a5', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'system-ui', textTransform: 'capitalize', whiteSpace: 'nowrap', transition: 'background 0.15s ease' }}>{t}</button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {sandbox && <span style={css.badge('#818cf8', '#fff')}>🧪 Sandbox</span>}
          {!sandbox && <button onClick={enterSandbox} style={{ background: 'transparent', border: '1px solid #3b4268', color: '#8b92a5', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer', fontFamily: 'system-ui' }}>What-If</button>}
          <button onClick={() => setShowSearch(true)} style={{ background: 'transparent', border: '1px solid #3b4268', color: '#8b92a5', borderRadius: 6, padding: '5px 10px', fontSize: 14, cursor: 'pointer' }}>🔍</button>
          <button onClick={() => { setRole(null); setPodFilter(null); }} style={{ background: 'transparent', border: '1px solid #3b4268', color: '#8b92a5', borderRadius: 6, padding: '5px 12px', fontSize: 13, cursor: 'pointer', fontFamily: 'system-ui' }}>Sign Out</button>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {activeData.people.length === 0 && activeData.clients.length === 0 && tab === 'dashboard' ? (
          <WelcomeDashboard onLoadSample={() => setData(() => JSON.parse(JSON.stringify(SAMPLE_DATA)))} />
        ) : (
          <>
            {tab === 'dashboard' && <Dashboard data={activeData} onOpenDetail={openDetail} onOpenGaps={() => setShowGaps(true)} onOpenPeopleSummary={() => setShowPeopleSummary(true)} />}
            {tab === 'people' && <PeopleTab data={activeData} setData={setData} onOpenDetail={openDetail} />}
            {tab === 'clients' && <ClientsTab data={activeData} setData={setData} onOpenDetail={openDetail} />}
            {tab === 'data' && <DataTab data={activeData} setData={setData} />}
            {tab === 'settings' && <SettingsTab data={activeData} setData={setData} />}
          </>
        )}

        {/* Detail Panels */}
        {detailPanel?.type === 'person' && (
          <PersonDetail data={activeData} setData={setData} personId={detailPanel.id} onClose={() => setDetailPanel(null)} onOpenDetail={openDetail} />
        )}
        {detailPanel?.type === 'client' && (
          <ClientDetail data={activeData} setData={setData} clientId={detailPanel.id} onClose={() => setDetailPanel(null)} onOpenDetail={openDetail} onOpenRoster={setRosterContext} />
        )}

        {/* People Summary */}
        {showPeopleSummary && <PeopleSummaryPanel data={activeData} onClose={() => setShowPeopleSummary(false)} onOpenDetail={openDetail} />}

        {/* Staffing Gaps */}
        {showGaps && (
          <StaffingGapsPanel
            data={activeData}
            setData={setData}
            onClose={() => setShowGaps(false)}
            onOpenDetail={openDetail}
            onOpenRoster={setRosterContext}
            onPreviewScenario={sc => {
              const sbData = JSON.parse(JSON.stringify(data));
              sc.moves.forEach(m => {
                sbData.assignments = sbData.assignments.map(a => a.id === m.gapAssignmentId && isPlaceholder(a.personId) ? { ...a, personId: m.personId } : a);
              });
              setOriginalData(JSON.parse(JSON.stringify(data)));
              setSandboxData(sbData);
              setSandbox(true);
              setScenarioPreview(sc);
              setShowGaps(false);
              setTab('dashboard');
            }}
          />
        )}

        {/* Roster Modal */}
        {rosterContext && <RecommendationRoster data={activeData} setData={setData} context={rosterContext} onClose={() => setRosterContext(null)} onOpenDetail={openDetail} />}

        {/* Gap Notes */}
        {gapNotesId && <GapNotesModal data={activeData} setData={setData} assignmentId={gapNotesId} onClose={() => setGapNotesId(null)} />}

        {/* Budget Modal */}
        {budgetModal && (() => {
          const client = activeData.clients.find(c => c.id === budgetModal);
          return client ? (
            <BudgetWorksheet
              client={client}
              budget={(activeData.budgets || {})[client.id]}
              settings={activeData.settings}
              assignments={activeData.assignments}
              people={activeData.people}
              onSave={(id, budget) => {
                setData(d => {
                  const budgets = { ...(d.budgets || {}) };
                  if (budget === null) delete budgets[id];
                  else budgets[id] = budget;
                  return { ...d, budgets };
                });
                setBudgetModal(null);
              }}
              onClose={() => setBudgetModal(null)}
              budgetTemplates={activeData.budgetTemplates || []}
            />
          ) : null;
        })()}

        {/* Search */}
        {showSearch && <GlobalSearch data={activeData} onSelect={openDetail} onClose={() => setShowSearch(false)} />}
      </div>

      {/* Sandbox Bar */}
      {sandbox && originalData && (
        <SandboxBar
          liveData={data}
          sandboxData={sandboxData}
          originalData={originalData}
          scenarioName={scenarioPreview?.name}
          onDiscard={() => exitSandbox(false)}
          onApply={() => exitSandbox(true)}
          onOpenDetail={openDetail}
        />
      )}
    </div>
  );
}
