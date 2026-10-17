import { IsArray, IsNotEmpty, IsNumber } from 'class-validator';

export class DeleteWordsDto {
  @IsArray()
  @IsNotEmpty()
  @IsNumber({}, { each: true })
  ids: number[];
}

export class ResetProgressDto {
  @IsArray()
  @IsNotEmpty()
  @IsNumber({}, { each: true })
  ids: number[];
}