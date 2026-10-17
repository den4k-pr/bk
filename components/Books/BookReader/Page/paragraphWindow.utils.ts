export function lowerBoundBlockEnd(offsets: number[], rangeTop: number, n: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] >= rangeTop) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

export function upperBoundBlockStart(offsets: number[], rangeBottom: number, n: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= rangeBottom) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
