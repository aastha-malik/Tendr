import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatTimer } from '../../utils/formatters';
import { useAuth } from '../../contexts/AuthContext';
import { focusAPI } from '../../api/client';
import { PetSprite } from '../PetSprite';
import type { Species, Stage, Mood } from '../PetSprite';

interface FocusTimerProps {
  petName?: string;
  petSpecies?: Species;
  petStage?: Stage;
  petMood?: Mood;
}

const DURATION_OPTIONS = [
  { label: '5s',     secs: 5,       display: '5 SEC'  },
  { label: '25 min', secs: 25 * 60, display: '25 MIN' },
  { label: '45 min', secs: 45 * 60, display: '45 MIN' },
  { label: '60 min', secs: 60 * 60, display: '60 MIN' },
] as const;

const DEFAULT_SECS = 45 * 60;
const MIN_SAVE_SECS = 5;
const ORIGINAL_TITLE = document.title;

export default function FocusTimer({
  petName = 'your pet',
  petSpecies = 'dog',
  petStage = 'adult',
  petMood = 'content',
}: FocusTimerProps) {
  const [selectedSecs, setSelectedSecs] = useState<number>(DEFAULT_SECS);
  const [timeLeft, setTimeLeft] = useState<number>(DEFAULT_SECS);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string>('');
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editHrs, setEditHrs] = useState<string>('');
  const [editMin, setEditMin] = useState<string>('');
  const [editSec, setEditSec] = useState<string>('');
  const hrsRef = useRef<HTMLInputElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const isAuthRef = useRef(false);
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const { mutate: saveSession } = useMutation({
    mutationFn: (duration_seconds: number) => focusAPI.saveSession(duration_seconds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['focusTotal'] });
      queryClient.invalidateQueries({ queryKey: ['focusToday'] });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 3000);
    },
    onError: (err: Error) => {
      setSaveStatus('error');
      setSaveError(err.message ?? 'Save failed');
      setTimeout(() => setSaveStatus('idle'), 5000);
    },
  });

  useEffect(() => {
    if (isRunning) {
      document.title = `⏱ ${formatTimer(timeLeft)} — Tendr`;
    } else {
      document.title = ORIGINAL_TITLE;
    }
    return () => { document.title = ORIGINAL_TITLE; };
  }, [isRunning, timeLeft]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // Keep auth + saveSession in refs so the save effect never re-fires due to their identity
  const saveSessionRef = useRef(saveSession);
  useEffect(() => { isAuthRef.current = isAuthenticated; }, [isAuthenticated]);
  useEffect(() => { saveSessionRef.current = saveSession; }, [saveSession]);

  // Save on pause / timer completion — depends ONLY on isRunning so nothing else
  // can accidentally reset startTimeRef while the timer is ticking
  useEffect(() => {
    if (!isRunning && startTimeRef.current !== null) {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      startTimeRef.current = null;
      if (elapsed >= MIN_SAVE_SECS && isAuthRef.current) saveSessionRef.current(elapsed);
    }
    if (isRunning) startTimeRef.current = Date.now();
  }, [isRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save on unmount — fires when navigating away while the timer is still running
  useEffect(() => {
    return () => {
      const start = startTimeRef.current;
      if (start !== null && isAuthRef.current) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (elapsed >= MIN_SAVE_SECS) {
          focusAPI.saveSession(elapsed).catch(() => {});
        }
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop the timer when it reaches 0 — kept separate so the updater stays pure
  useEffect(() => {
    if (timeLeft === 0 && isRunning) setIsRunning(false);
  }, [timeLeft, isRunning]);

  useEffect(() => {
    if (isRunning && timeLeft > 0) {
      intervalRef.current = setInterval(() => {
        setTimeLeft(prev => (prev <= 1 ? 0 : prev - 1));
      }, 1000);
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isRunning, timeLeft]);

  const handleStart = () => {
    setIsEditing(false);
    if (timeLeft === 0) setTimeLeft(selectedSecs);
    setIsRunning(true);
  };
  const handlePause = () => setIsRunning(false);
  const handleReset = () => {
    setIsRunning(false);
    setIsEditing(false);
    setTimeLeft(selectedSecs);
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };
  const handleLengthChange = (secs: number) => {
    if (!isRunning) { setSelectedSecs(secs); setTimeLeft(secs); setIsEditing(false); }
  };

  const enterEditMode = () => {
    if (isRunning) { handlePause(); return; }
    const h = Math.floor(selectedSecs / 3600);
    const m = Math.floor((selectedSecs % 3600) / 60);
    const s = selectedSecs % 60;
    setEditHrs(h > 0 ? String(h) : '');
    setEditMin(String(m));
    setEditSec(s > 0 ? String(s) : '');
    setIsEditing(true);
    setTimeout(() => hrsRef.current?.focus(), 0);
  };

  const applyEdit = () => {
    const h = parseInt(editHrs || '0', 10);
    const m = parseInt(editMin || '0', 10);
    const s = parseInt(editSec || '0', 10);
    const total = h * 3600 + m * 60 + s;
    if (total >= MIN_SAVE_SECS) {
      setSelectedSecs(total);
      setTimeLeft(total);
    }
    setIsEditing(false);
  };

  const getDisplayLabel = (secs: number) => {
    const preset = DURATION_OPTIONS.find(o => o.secs === secs);
    if (preset) return preset.display;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0 && m > 0) return `${h} HR ${m} MIN`;
    if (h > 0) return `${h} HR`;
    return `${m} MIN`;
  };

  const progressPct = selectedSecs > 0 ? ((selectedSecs - timeLeft) / selectedSecs) * 100 : 0;

  // Shared style for edit inputs (match the big timer font)
  const inputStyle = (fs: boolean): React.CSSProperties => ({
    fontFamily: 'Fraunces, Georgia, serif',
    fontSize: fs ? 'clamp(64px, 10vw, 110px)' : 'clamp(44px, 13vw, 72px)',
    letterSpacing: -3,
    fontFeatureSettings: '"tnum"',
    color: 'var(--accent)',
    background: 'none',
    border: 'none',
    borderBottom: '2px dashed var(--accent)',
    outline: 'none',
    width: '2.4ch',
    padding: '0 0 4px 0',
    textAlign: 'center',
    MozAppearance: 'textfield',
  });

  const unitStyle: React.CSSProperties = {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: 10,
    color: 'var(--muted)',
    letterSpacing: '2px',
    textTransform: 'uppercase',
    alignSelf: 'flex-end',
    paddingBottom: 8,
  };

  const editBlock = (fs: boolean) => (
    <div
      style={{ display: 'flex', alignItems: 'flex-end', gap: 4, marginBottom: fs ? 28 : 16, flexWrap: 'wrap' }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) applyEdit(); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); applyEdit(); }
        if (e.key === 'Escape') setIsEditing(false);
      }}
    >
      <input
        ref={hrsRef}
        type="number"
        value={editHrs}
        onChange={e => setEditHrs(e.target.value)}
        onFocus={e => e.target.select()}
        placeholder="00"
        min={0} max={23}
        style={inputStyle(fs)}
      />
      <span style={unitStyle}>hrs</span>

      <input
        type="number"
        value={editMin}
        onChange={e => setEditMin(e.target.value)}
        onFocus={e => e.target.select()}
        placeholder="00"
        min={0} max={59}
        style={{ ...inputStyle(fs), marginLeft: fs ? 12 : 8 }}
      />
      <span style={unitStyle}>min</span>

      <input
        type="number"
        value={editSec}
        onChange={e => setEditSec(e.target.value)}
        onFocus={e => e.target.select()}
        placeholder="00"
        min={0} max={59}
        style={{ ...inputStyle(fs), marginLeft: fs ? 12 : 8 }}
      />
      <span style={unitStyle}>sec</span>
    </div>
  );

  const bigTimer = (fs: boolean) => (
    isEditing ? editBlock(fs) : (
      <div
        onClick={isRunning ? handlePause : enterEditMode}
        title={isRunning ? 'Click to pause' : 'Click to set duration'}
        style={{
          fontFamily: 'Fraunces, Georgia, serif',
          fontSize: fs ? 'clamp(80px, 14vw, 160px)' : 'clamp(52px, 18vw, 88px)',
          letterSpacing: -4,
          lineHeight: 1,
          fontFeatureSettings: '"tnum"',
          color: 'var(--accent)',
          cursor: isRunning ? 'pointer' : 'text',
          userSelect: 'none',
          marginBottom: fs ? 28 : 16,
        }}
      >
        {formatTimer(timeLeft)}
      </div>
    )
  );

  const progressBar = (fs: boolean) => (
    <svg width="100%" height="22" viewBox="0 0 300 22" preserveAspectRatio="none"
      style={{ display: 'block', marginBottom: fs ? 28 : 12 }}>
      <line x1="0" y1="11" x2="300" y2="11" stroke="var(--rule)" strokeWidth="1" strokeDasharray="3 4" />
      <line x1="0" y1="11" x2={300 * progressPct / 100} y2="11" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );

  const presetButtons = (fs: boolean) => (
    <div style={{ display: 'flex', gap: fs ? 16 : 10, alignItems: 'baseline' }}>
      {DURATION_OPTIONS.map(({ label, secs }) => (
        <button
          key={secs}
          onClick={() => handleLengthChange(secs)}
          disabled={isRunning}
          style={{
            fontFamily: 'Fraunces, Georgia, serif',
            fontSize: fs ? 16 : 14,
            color: selectedSecs === secs && !isEditing ? 'var(--ink)' : 'var(--muted)',
            fontStyle: selectedSecs === secs && !isEditing ? 'normal' : 'italic',
            background: 'none',
            border: 'none',
            borderBottom: `2px solid ${selectedSecs === secs && !isEditing ? 'var(--accent)' : 'transparent'}`,
            cursor: isRunning ? 'not-allowed' : 'pointer',
            opacity: isRunning && selectedSecs !== secs ? 0.4 : 1,
            padding: '0 0 2px 0',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const actionButtons = (fs: boolean) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <button
        onClick={isRunning ? handlePause : handleStart}
        style={{
          background: 'var(--ink)',
          color: 'var(--paper)',
          padding: fs ? '10px 24px' : '6px 14px',
          fontFamily: '"Inter", system-ui, sans-serif',
          fontSize: fs ? 14 : 12,
          fontWeight: 500,
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {isRunning ? 'Pause' : 'Start'}
      </button>
      <button
        onClick={handleReset}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 9, color: 'var(--muted)', letterSpacing: 1, textTransform: 'uppercase' }}
      >
        Reset
      </button>
    </div>
  );

  const statusChip = (
    <>
      {isRunning && <span style={{ fontFamily: 'Fraunces, Georgia, serif', fontStyle: 'italic', fontSize: 13, color: 'var(--ink-soft)' }}>stay with it.</span>}
      {saveStatus === 'saved' && <span style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 9, letterSpacing: 1, color: 'var(--accent-3)', textTransform: 'uppercase' }}>saved ✓</span>}
      {saveStatus === 'error' && <span style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 9, letterSpacing: 1, color: 'tomato', textTransform: 'uppercase' }} title={saveError}>save failed ✗</span>}
    </>
  );

  // ── FULLSCREEN ──
  if (isFullscreen) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'var(--paper)', display: 'flex', alignItems: 'center', padding: '0 6vw', gap: '6vw' }}>

        <button
          onClick={() => setIsFullscreen(false)}
          title="Exit fullscreen (Esc)"
          style={{ position: 'absolute', top: 24, right: 28, background: 'none', border: 'none', cursor: 'pointer', fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 11, color: 'var(--muted)', letterSpacing: 1, textTransform: 'uppercase', padding: '4px 8px' }}
        >
          esc ✕
        </button>

        <div style={{ flex: '0 0 55%', minWidth: 0 }}>
          <div style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 11, letterSpacing: '2px', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            SIT WITH {petName.toUpperCase()} · {getDisplayLabel(selectedSecs)}
            {statusChip}
          </div>

          {bigTimer(true)}
          {!isEditing && progressBar(true)}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            {presetButtons(true)}
            {actionButtons(true)}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, minWidth: 0 }}>
          <PetSprite
            species={petSpecies}
            stage={petStage}
            mood={isRunning ? 'happy' : petMood}
            size={Math.min(window.innerWidth * 0.32, 420)}
          />
          <div style={{ fontFamily: 'Fraunces, Georgia, serif', fontStyle: 'italic', fontSize: 15, color: 'var(--ink-soft)', textAlign: 'center' }}>
            {isRunning ? `${petName} is happy you're here.` : `${petName} is waiting for you.`}
          </div>
        </div>
      </div>
    );
  }

  // ── NORMAL CARD ──
  return (
    <div style={{ border: '1.5px solid var(--ink)', padding: 20, background: 'var(--card)', marginTop: 22 }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 10, letterSpacing: '2px', color: 'var(--muted)', textTransform: 'uppercase' }}>
          SIT WITH {petName.toUpperCase()} · {getDisplayLabel(selectedSecs)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {statusChip}
          <button
            onClick={() => setIsFullscreen(true)}
            title="Fullscreen"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--muted)', lineHeight: 1, fontSize: 13, opacity: 0.7 }}
          >
            ⛶
          </button>
        </div>
      </div>

      {bigTimer(false)}
      {!isEditing && progressBar(false)}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        {presetButtons(false)}
        {actionButtons(false)}
      </div>
    </div>
  );
}
