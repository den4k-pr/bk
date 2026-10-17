export interface StageProgress {
  step1: boolean;
  step2: boolean;
  step3: boolean;
}

export class UpdateUserWordProgressBatchDto {
  words: { id: number; progress: StageProgress }[];
}
