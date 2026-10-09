/**
 * 任务状态机：next / finish / abandon 的本地编排（防重入、防并发双发）
 * 状态：idle → fetching → playing → (settle) → idle
 * finish 被拒（job_expired 等）→ 明示并进入下一单（无宽容语义）
 */
import { EventBus } from './events.js';
import type { ApiResult, FinishInput, JobPhase, NextPayload } from './types.js';

export interface DispatchDeps {
  next(): Promise<ApiResult<NextPayload>>;
  finish(input: FinishInput): Promise<ApiResult<{ settled?: boolean }>>;
  abandon(reason: string, detail: string): Promise<void>;
  /** 播放开始回调：由 UI/播放器拉起心跳 */
  onPlaying(job: CurrentJob): void;
  /** 结算失败提示（403/过期等）——明示「无心跳未结算，请重新听」 */
  onSettleFailed(code: string, msg: string): void;
}

export interface CurrentJob {
  jobId: string;
  musicId: string;
  musicName: string;
  targetMs: number;
  playedMs: number;
}

export class JobStateMachine {
  phase: JobPhase = 'idle';
  current: CurrentJob | null = null;
  private busy = false; // 防重入
  private finishing: CurrentJob | null = null;

  constructor(private deps: DispatchDeps, private bus: EventBus) {}

  private setPhase(p: JobPhase): void {
    this.phase = p;
    this.bus.emit('job:phase', p);
  }

  /** 领取下一单（空闲时调用；防并发） */
  async fetchNext(): Promise<NextPayload | null> {
    if (this.busy || this.phase !== 'idle') return null;
    this.busy = true;
    this.setPhase('fetching');
    try {
      const r = await this.deps.next();
      if (r.status === 200 && r.payload && r.payload.jobId && r.payload.musicId) {
        this.current = {
          jobId: r.payload.jobId,
          musicId: r.payload.musicId,
          musicName: String(r.payload.musicId),
          targetMs: r.payload.requiredListenMs ?? r.payload.targetDurationMs ?? 0,
          playedMs: 0,
        };
        this.setPhase('playing');
        this.bus.emit('job:current', this.current);
        this.deps.onPlaying(this.current);
        return r.payload;
      }
      // noTarget / 无单：回 idle（reason 由调用方展示）
      this.setPhase('idle');
      return r.payload ?? null;
    } catch (error) {
      if (this.current) this.clear(this.current);
      else this.setPhase('idle');
      throw error;
    } finally {
      this.busy = false;
    }
  }

  updateProgress(playedMs: number): void {
    if (!this.current) return;
    this.current.playedMs = Math.max(this.current.playedMs, playedMs);
    this.bus.emit('job:progress', { jobId: this.current.jobId, playedMs, positionMs: playedMs });
  }

  /** 播放完成提交 */
  async submitFinish(input: FinishInput): Promise<'settled' | 'rejected' | 'error'> {
    const job = this.current;
    if (!job || this.phase !== 'playing' || this.finishing === job || input.jobId !== job.jobId) return 'error';
    this.finishing = job;
    try {
      const r = await this.deps.finish(input);
      if (this.current !== job || this.phase !== 'playing') return 'error';
      if (r.status === 200 && r.payload && r.payload.settled !== false) {
        return 'settled';
      }
      this.deps.onSettleFailed(String(r.status), String(r.error ?? '结算被拒绝，请重新听'));
      return r.status === 403 || r.payload?.settled === false ? 'rejected' : 'error';
    } catch (error) {
      if (this.current === job && this.phase === 'playing') this.deps.onSettleFailed('network_error', String(error));
      return 'error';
    } finally {
      if (this.phase === 'playing') this.clear(job);
      if (this.finishing === job) this.finishing = null;
    }
  }

  /** 主动放弃（30s 无首心跳 / 45s 心跳中断 / 播放器错误） */
  async abandon(reason: string, detail: string): Promise<void> {
    const job = this.current;
    if (!job || this.phase === 'abandoning') return;
    this.setPhase('abandoning');
    try {
      await this.deps.abandon(reason, detail);
    } finally {
      this.clear(job);
    }
  }

  private clear(job: CurrentJob): void {
    if (this.current !== job) return;
    this.current = null;
    this.setPhase('idle');
    this.bus.emit('job:current', null);
  }
}
