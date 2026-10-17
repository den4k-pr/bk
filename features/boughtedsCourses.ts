import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface Course {
  id: number;
  value: boolean;
}

interface BoughtCoursesState {
  courses: Course[];
}

const initialState: BoughtCoursesState = {
  courses: [
    { id: 1, value: false },
    { id: 2, value: false },
    { id: 3, value: false },
    { id: 4, value: false },
    { id: 5, value: false },
    { id: 6, value: false },
    { id: 7, value: false },
    { id: 8, value: false },
  ],
};

const boughtCoursesSlice = createSlice({
  name: 'boughtCourses',
  initialState,
  reducers: {
    toggleCourse(state, action: PayloadAction<{ id: number; value: boolean }>) {
      const { id, value } = action.payload;
      state.courses = state.courses.map(course =>
        course.id === id ? { ...course, value } : course
      );
      state.courses.sort((a, b) => a.id - b.id);
    },
    // Вихід / зміна акаунта: куплені курси належать акаунту, а не телефону.
    resetBoughtCourses() {
      return initialState;
    },
  },
});

export const { toggleCourse, resetBoughtCourses } = boughtCoursesSlice.actions;
export default boughtCoursesSlice.reducer;
