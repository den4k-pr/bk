import { useSelector } from "react-redux"
import { totalWordsOfList } from "../../lists/totallWordsOfList"
import { RootState } from "../../../store"

export const getTotals = (list: typeof totalWordsOfList) => 
  list.reduce(
    (acc, item) => {
      acc.total += item.studiet + item.studing + item.wasNotStudied
      acc.studied += item.studiet
      acc.studing += item.studing
      acc.notStudied += item.wasNotStudied
      return acc
    },
    { total: 0, studied: 0, studing: 0, notStudied: 0 }
  );

// total === 0 (напр. вибрали рівень, якого немає в списку) раніше давав
// 0/0 = NaN, і в UI їхало "NaN%" замість "0%".
export const getPercentages = ({ total, studied, studing, notStudied }: { total: number; studied: number; studing: number; notStudied: number }) => ({
  studiedPercentage: total > 0 ? (studied / total) * 100 : 0,
  studingPercentage: total > 0 ? (studing / total) * 100 : 0,
  notStudiedPercentage: total > 0 ? (notStudied / total) * 100 : 0
})

export const calculatePercentages = () => {
  const selectedValue = useSelector((state: RootState) => state.level.selectedLevel)

  const totalWordsTotals = getTotals(totalWordsOfList)
  const allPercentages = getPercentages(totalWordsTotals)

  const levelList = totalWordsOfList.filter(item => item.level === selectedValue)
  const levelTotals = getTotals(levelList)
  const levelPercentages = getPercentages(levelTotals)

  const totalStudiedSum = totalWordsOfList.reduce((sum, item) => sum + item.studiet, 0)
  const totalStudingSum = totalWordsOfList.reduce((sum, item) => sum + item.studing, 0)
  const totalNotStudiedSum = totalWordsOfList.reduce((sum, item) => sum + item.wasNotStudied, 0)

  return {
    totalWords: totalWordsTotals.total,
    totalStudied: totalWordsTotals.studied,
    totalStuding: totalWordsTotals.studing,
    totalNotStudied: totalWordsTotals.notStudied,
    studiedPercentage: allPercentages.studiedPercentage,
    studingPercentage: allPercentages.studingPercentage,
    notStudiedPercentage: allPercentages.notStudiedPercentage,

    totalStudiedSum,
    totalStudingSum,
    totalNotStudiedSum,

    totalWordsByLevel: levelTotals.total,
    totalStudiedByLevel: levelTotals.studied,
    totalStudingByLevel: levelTotals.studing,
    totalNotStudiedByLevel: levelTotals.notStudied,
    studiedPercentageByLevel: levelPercentages.studiedPercentage,
    studingPercentageByLevel: levelPercentages.studingPercentage,
    notStudiedPercentageByLevel: levelPercentages.notStudiedPercentage
  }
}
