import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { tasksAPI, petsAPI, statsAPI, userAPI, focusAPI } from '../api/client';
import TaskList from '../components/tasks/TaskList';
import TaskForm from '../components/tasks/TaskForm';
import TaskItem from '../components/tasks/TaskItem';
import FocusTimer from '../components/focus/FocusTimer';
import Toast from '../components/ui/Toast';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useToast } from '../hooks/useToast';
import { PetSprite, getStage, deriveMood } from '../components/PetSprite';
import type { Species } from '../components/PetSprite';
import { Heatmap } from '../components/ui/Heatmap';
import type { Task } from '../api/types';

function getMoodSubtitle(streak: number, completedToday: number, petName: string, petMood: string): string {
  if (completedToday >= 3) return `Sun's out. ${petName} is doing zoomies.`;
  if (completedToday >= 1) return `A gentle drizzle. ${petName} is watching the window.`;
  if (streak >= 3) return `Overcast, but familiar. ${petName} is waiting for you.`;
  if (petMood === 'happy') return `A light drizzle. ${petName} is feeling great.`;
  if (petMood === 'sleepy') return `A light drizzle. ${petName} is drowsy today.`;
  if (petMood === 'sad') return `A light drizzle. ${petName} is feeling lonely.`;
  return `A light drizzle. ${petName} is sleeping in.`;
}


function formatDayCounter(petAge?: number): string {
  if (!petAge) return 'DAY 001';
  return `DAY ${String(Math.floor(petAge)).padStart(3, '0')}`;
}

function computeBelly(lastFed: string): number {
  const days = Math.floor((Date.now() - new Date(lastFed).getTime()) / 86400000);
  return Math.max(0, 100 - days * 33);
}

function computeBond(storedBond: number, lastFocused: string): number {
  const days = Math.floor((Date.now() - new Date(lastFocused).getTime()) / 86400000);
  return Math.max(0, Math.round(storedBond - days * 33));
}

function getDateEyebrow(): string {
  const now = new Date();
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${days[now.getDay()]} · ${now.getDate()} ${months[now.getMonth()]}`;
}


function buildHeatmapData(tasks: Task[]): number[] {
  // 21 days: index 0 = 20 days ago, index 20 = today
  const counts = Array(21).fill(0);
  const now = new Date();
  tasks.forEach(task => {
    if (!task.completed) return;
    const d = new Date(task.created_at);
    const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diff >= 0 && diff < 21) counts[20 - diff]++;
  });
  return counts;
}

export default function Today() {
  const { isAuthenticated } = useAuth();
  const { toasts, showToast, removeToast } = useToast();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const feedMutation = useMutation({
    mutationFn: (petId: string) => petsAPI.feed(petId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pets'] });
      queryClient.invalidateQueries({ queryKey: ['userXP'] });
      showToast('Fed. She looks pleased.', 'success');
    },
    onError: () => showToast('Could not feed right now.', 'error'),
  });
  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => tasksAPI.delete(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['userXP'] });
    },
    onError: () => showToast('Could not delete task.', 'error'),
  });

  const XP_BY_PRIORITY: Record<string, number> = { High: 25, Medium: 15, Low: 10 };

  const handleLateDelete = (t: Task) => {
    const daysLate = Math.floor((Date.now() - new Date(t.due_date ?? t.created_at).getTime()) / 86400000);
    const base = t.points ?? XP_BY_PRIORITY[t.priority ?? ''] ?? 10;
    const rawPoints = base - 3 * daysLate;
    setPendingLateDelete({ ...t, xpReward: rawPoints });
  };


  const [activeCategory, setActiveCategory] = useState<string>('');
  const [pendingLateDelete, setPendingLateDelete] = useState<Task | null>(null);
  const CATEGORIES = ['Work', 'Personal', 'Home', 'Friends', 'Health'];

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => tasksAPI.getAll(),
    enabled: isAuthenticated,
  });

  const { data: pets = [] } = useQuery({
    queryKey: ['pets'],
    queryFn: () => petsAPI.getAll(),
    enabled: isAuthenticated,
  });

  const { data: userXP } = useQuery({
    queryKey: ['userXP'],
    queryFn: () => userAPI.getXP(),
    enabled: isAuthenticated,
    refetchInterval: 30000,
  });

  // Get userId from tasks or pets for stats
  const userId = tasks[0]?.user_id ?? pets[0]?.user_id;
  const { data: stats } = useQuery({
    queryKey: ['stats', userId],
    queryFn: () => statsAPI.getStats(userId!),
    enabled: isAuthenticated && !!userId,
  });

  const { data: focusToday } = useQuery({
    queryKey: ['focusToday'],
    queryFn: () => focusAPI.getToday(),
    enabled: isAuthenticated,
    refetchInterval: 30000,
  });

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isPast = (dateStr: string) => {
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);
    return d < todayMidnight;
  };
  const lateTasks = tasks.filter(t => !t.completed && isPast(t.due_date ?? t.created_at));

  const alivePet = pets.find(p => p.is_alive);
  const pet = alivePet ?? pets[0];
  const petIsDead = !alivePet && !!pet;
  const completedToday = tasks.filter(t => {
    if (!t.completed || !t.completed_at) return false;
    const d = new Date(t.completed_at);
    const now = new Date();
    return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const streak = stats?.streaks ?? 0;
  const heatmapData = buildHeatmapData(tasks);

  const todayFocusSecs = focusToday?.total_seconds ?? 0;
  const todayFocusHrs = Math.floor(todayFocusSecs / 3600);
  const todayFocusMins = Math.floor((todayFocusSecs % 3600) / 60);
  const todayFocusRemSecs = todayFocusSecs % 60;
  const todayFocusDisplay = todayFocusSecs === 0
    ? '—'
    : todayFocusHrs === 0 && todayFocusMins === 0
      ? `${todayFocusRemSecs} sec`
      : todayFocusHrs === 0
        ? `${todayFocusMins} min`
        : todayFocusMins === 0
          ? `${todayFocusHrs} ${todayFocusHrs === 1 ? 'hr' : 'hrs'}`
          : `${todayFocusHrs} ${todayFocusHrs === 1 ? 'hr' : 'hrs'} ${todayFocusMins} min`;

  const belly = pet ? computeBelly(pet.last_fed) : 50;
  const bond = pet ? computeBond(pet.bond ?? 0, pet.last_focused_at ?? pet.last_fed) : 0;
  const petSpecies = (pet?.type?.toLowerCase() === 'cat' ? 'cat' : 'dog') as Species;
  const petStage = getStage(pet?.age ?? 0);
  const petMood = pet ? deriveMood(belly, bond) : 'content';
  const moodValue = ({ happy: 100, content: 67, sleepy: 33, sad: 0 } as const)[petMood];
  const petName = pet?.name ?? 'Tendr';
  const dayCounter = formatDayCounter(pet?.age);

  const monoStyle: React.CSSProperties = {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: 10,
    letterSpacing: '2px',
    color: 'var(--muted)',
    textTransform: 'uppercase',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', padding: isMobile ? '16px' : '24px 36px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.4fr 1fr', gap: isMobile ? 20 : 30, maxWidth: 1200, margin: '0 auto' }}>

        {/* ── LEFT COLUMN ── */}
        <div>
          {/* Eyebrow */}
          <div style={{ ...monoStyle, marginBottom: 4 }}>
            {getDateEyebrow()}{!petIsDead && pet ? ` · ${dayCounter} WITH ${petName.toUpperCase()}` : ''}
          </div>

          {/* H1 */}
          <h1 style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: isMobile ? 30 : 44, letterSpacing: -1.2, lineHeight: 1, color: 'var(--ink)', margin: '0 0 6px' }}>
            Today's page.
          </h1>

          {/* Mood subtitle */}
          <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontStyle: 'italic', fontSize: 16, color: 'var(--ink-soft)', marginBottom: 22 }}>
            {getMoodSubtitle(streak, completedToday, petName, petMood)}
          </div>

          {/* Task list section */}
          <div style={{ marginTop: 22 }}>
            {/* Header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', ...monoStyle, borderBottom: '1px solid var(--rule)', paddingBottom: 6, marginBottom: 8 }}>
              <span>TO DO</span>
              <span>{tasks.filter(t => !t.completed).length} items · {tasks.filter(t => !t.completed).reduce((s, t) => s + (t.xpReward ?? (t.priority === 'High' ? 25 : t.priority === 'Medium' ? 15 : 10)), 0)} xp possible</span>
            </div>

            {/* Category filter bar */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {CATEGORIES.map(c => (
                <button
                  key={c}
                  onClick={() => setActiveCategory(activeCategory === c ? '' : c)}
                  style={{
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontSize: 9,
                    letterSpacing: '1.5px',
                    textTransform: 'uppercase',
                    padding: '3px 8px',
                    background: activeCategory === c ? 'var(--accent-3)' : 'transparent',
                    color: activeCategory === c ? 'var(--paper)' : 'var(--muted)',
                    border: `1px solid ${activeCategory === c ? 'var(--accent-3)' : 'var(--rule)'}`,
                    cursor: 'pointer',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>

            <TaskList onError={e => showToast(e.message, 'error')} activeCategory={activeCategory} />
            <TaskForm
              onSuccess={() => showToast('Task added.', 'success')}
              onError={e => showToast(e.message, 'error')}
            />
          </div>

          {/* Ledger card */}
          <div style={{ marginTop: 22, border: '1px solid var(--rule)', padding: 20, background: 'var(--card)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
              <div>
                <div style={monoStyle}>THE LEDGER · TODAY</div>
                <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 22, fontStyle: 'italic', marginTop: 2, color: 'var(--ink)' }}>
                  How the season has been treating you.
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 1fr', gap: 18, marginBottom: 16, paddingBottom: 14, borderBottom: '1px dashed var(--rule)' }}>
              {[
                ['TASKS FINISHED', String(completedToday), 'var(--accent)'],
                ['TIME TOGETHER', todayFocusDisplay, 'var(--accent-3)'],
                ['STREAK', `${streak} days`, 'var(--amber)'],
              ].map(([label, value, color]) => (
                <div key={label}>
                  <div style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 9, color: 'var(--muted)', letterSpacing: '1.5px', textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 32, fontWeight: 500, color, letterSpacing: -1, fontFeatureSettings: '"tnum"', marginTop: 2 }}>{value}</div>
                </div>
              ))}
            </div>
            <Heatmap data={heatmapData} />
          </div>

          {/* Focus card */}
          <FocusTimer petName={petName} petSpecies={petSpecies} petStage={petStage} petMood={petMood} />
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div>
          {/* Pet eyebrow */}
          <div style={{ ...monoStyle, marginBottom: 6 }}>
            {!pet ? 'NO COMPANION YET'
              : petIsDead ? `${petName.toUpperCase()} · PASSED AWAY · ${dayCounter}`
                : [petName.toUpperCase(), pet.gender === 'female' ? '♀' : pet.gender === 'male' ? '♂' : null, dayCounter].filter(Boolean).join(' · ')}
          </div>

          {/* Pet card — empty / dead / alive states */}
          {!pet ? (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', padding: 40, textAlign: 'center' }}>
              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 52, marginBottom: 16, opacity: 0.18 }}>
                ʕ·ᴥ·ʔ
              </div>
              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 22, fontStyle: 'italic', letterSpacing: -0.4, color: 'var(--ink)', marginBottom: 8 }}>
                No companion yet.
              </div>
              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontStyle: 'italic', fontSize: 14, color: 'var(--ink-soft)', marginBottom: 24, lineHeight: 1.6 }}>
                A pet will live here once you adopt one.<br />They grow with every focus session and every task.
              </div>
              <a href="/pet" style={{ display: 'inline-block', padding: '10px 24px', background: 'var(--ink)', color: 'var(--paper)', fontFamily: '"Inter", system-ui, sans-serif', fontSize: 13, fontWeight: 500, textDecoration: 'none', letterSpacing: 0.2 }}>
                Adopt a companion →
              </a>
            </div>
          ) : petIsDead ? (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', padding: 22, textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center', opacity: 0.3, filter: 'grayscale(1)' }}>
                <PetSprite species={petSpecies} stage={petStage} mood="sad" size={210} />
              </div>
              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 24, fontStyle: 'italic', letterSpacing: -0.4, marginTop: 8, color: 'var(--ink)' }}>
                "{petName} has passed away."
              </div>
              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontStyle: 'italic', fontSize: 14, color: 'var(--ink-soft)', marginTop: 6, lineHeight: 1.6 }}>
                They made it to {dayCounter.toLowerCase()}.<br />Thank you for the time together.
              </div>
              <a href="/pet" style={{ display: 'inline-block', marginTop: 20, padding: '10px 24px', background: 'var(--ink)', color: 'var(--paper)', fontFamily: '"Inter", system-ui, sans-serif', fontSize: 13, fontWeight: 500, textDecoration: 'none', letterSpacing: 0.2 }}>
                Adopt a new companion →
              </a>
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', padding: 22, textAlign: 'center' }}>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <PetSprite species={petSpecies} stage={petStage} mood={petMood} size={210} />
              </div>

              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 26, fontStyle: 'italic', letterSpacing: -0.4, marginTop: 4, color: 'var(--ink)' }}>
                {petMood === 'happy' ? '"thriving today"'
                  : petMood === 'sad' ? '"feeling a little lonely"'
                    : petMood === 'sleepy' ? '"needs more time together"'
                      : '"doing alright"'}
              </div>
              <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 14, color: 'var(--ink-soft)', marginTop: 4 }}>
                {belly < 40 ? 'getting hungry — feed when you can.' : 'doing well for now.'}
              </div>

              {/* Progress bars: Mood + Belly + Bond */}
              <div style={{ marginTop: 18, textAlign: 'left' }}>
                {([
                  ['Mood', moodValue, 'var(--accent)'],
                  ['Belly', belly, 'var(--accent-2)'],
                  ['Bond', bond, 'var(--amber)'],
                ] as [string, number, string][]).map(([label, value, color]) => (
                  <div key={label} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 30px', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                    <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: 13, fontStyle: 'italic', color: 'var(--ink-soft)' }}>{label}</div>
                    <div style={{ height: 6, background: 'var(--paper-deep)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: color }} />
                    </div>
                    <div style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 10, color: 'var(--muted)', textAlign: 'right' }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Feed button */}
              <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                <button
                  onClick={() => pet && feedMutation.mutate(pet.id)}
                  disabled={!pet || !isAuthenticated || (userXP?.xp ?? 0) < 35 || feedMutation.isPending}
                  style={{
                    flex: 1,
                    background: 'var(--accent)',
                    color: 'white',
                    padding: '11px',
                    fontFamily: '"Inter", system-ui, sans-serif',
                    fontWeight: 600,
                    fontSize: 13,
                    letterSpacing: 0.3,
                    textAlign: 'center',
                    border: 'none',
                    cursor: (isAuthenticated && (userXP?.xp ?? 0) >= 35) ? 'pointer' : 'not-allowed',
                    opacity: (isAuthenticated && (userXP?.xp ?? 0) < 35) ? 0.5 : 1,
                  }}
                >
                  {feedMutation.isPending ? 'Feeding…' : 'Offer a treat · 35 xp'}
                </button>
              </div>
            </div>
          )}

          {/* Late tasks card */}
          {lateTasks.length > 0 && (
            <div style={{ marginTop: 14, border: '1px solid var(--accent)', background: 'var(--card)', padding: '14px 18px' }}>
              <div style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 9, letterSpacing: '2px', color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 6 }}>
                LATE · {lateTasks.length} UNFINISHED
              </div>
              {lateTasks.map(t => (
                <TaskItem
                  key={t.id}
                  task={t}
                  onDelete={() => handleLateDelete(t)}
                  onError={e => showToast(e.message, 'error')}
                />
              ))}
            </div>
          )}

        </div>
      </div>

      {toasts.map(t => (
        <Toast key={t.id} message={t.message} type={t.type} onClose={() => removeToast(t.id)} />
      ))}

      {pendingLateDelete && (() => {
        const penalty = pendingLateDelete.xpReward ?? 0;
        const hasXPLoss = penalty < 0;
        return (
          <ConfirmModal
            title={hasXPLoss ? `This will cost you ${Math.abs(penalty)} XP.` : 'Delete this late task?'}
            body={
              hasXPLoss
                ? `"${pendingLateDelete.title}" is long overdue. Deleting it will deduct ${Math.abs(penalty)} XP from your account. Are you sure?`
                : `"${pendingLateDelete.title}" is past its due date. Delete it anyway?`
            }
            confirmLabel={hasXPLoss ? `Delete (−${Math.abs(penalty)} XP)` : 'Delete'}
            onConfirm={() => {
              deleteTaskMutation.mutate(pendingLateDelete.id);
              setPendingLateDelete(null);
            }}
            onCancel={() => setPendingLateDelete(null)}
          />
        );
      })()}
    </div>
  );
}
