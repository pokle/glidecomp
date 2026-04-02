// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/** GAP scoring parameters for a sample competition */
export interface SampleCompGAPParams {
  scoring: 'HG' | 'PG';
  useLeading: boolean;
  useArrival: boolean;
  nominalDistance: number;
  nominalGoal: number;
  nominalTime: number;
  minimumDistance: number;
}

/** Metadata for a sample competition */
export interface SampleComp {
  id: string;
  name: string;
  taskFile: string;
  igcFiles: string[];
  gapParams: SampleCompGAPParams;
}

export const SAMPLE_COMPS: Record<string, SampleComp> = {
  'corryong-cup-2026-t1': {
    id: 'corryong-cup-2026-t1',
    name: 'Corryong Cup 2026 — Task 1',
    taskFile: 'task.xctsk',
    igcFiles: [
      'bissett-amess_206778_050126.igc',
      'blenkinsop_53049_050126.igc',
      'brown_23511_050126.igc',
      'burkitt_18393_050126.igc',
      'butler_302848_050126.igc',
      'carrigan_600344_050126.igc',
      'crosby_16380_050126.igc',
      'drabble_63164_050126.igc',
      'duncan_2205628_050126.igc',
      'durand_45515_050126.igc',
      'gunn_206367_050126.igc',
      'halsall_2206456_050126.igc',
      'hare_19455_050126.igc',
      'harriott_18769_050126.igc',
      'herman_202523_050126.igc',
      'holtkamp_33915_050126.igc',
      'hooke_34223_050126.igc',
      'horton_16829_050126.igc',
      'kerr_81520_050126.igc',
      'lamb_18239_050126.igc',
      'mcelroy_23579_050126.igc',
      'mcfarlane_19367_050126.igc',
      'opsanger_224971_050126.igc',
      'reinauer_228856_050126.igc',
      'rhodes_226312_050126.igc',
      'rigg_221455_050126.igc',
      'rowntree_2207635_050126.igc',
      'sutton_80138_050126.igc',
      'taylor_18240_050126.igc',
      'tefaili_19526_050126.igc',
      'van_der_leeden_85053_050126.igc',
      'vesk_18447_050126.igc',
      'wisewould_2206643_050126.igc',
    ],
    gapParams: {
      scoring: 'HG',
      useLeading: false,
      useArrival: false,
      nominalDistance: 35000,
      nominalGoal: 0.3,
      nominalTime: 5400,
      minimumDistance: 5000,
    },
  },
};
