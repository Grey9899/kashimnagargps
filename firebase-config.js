// কাশিমনগর সরকারি প্রাথমিক বিদ্যালয়ের Firebase কনফিগ।
// Firebase কনসোল → Project settings → Your apps → Web app থেকে মানগুলো কপি করে নিচে বসান।
// এগুলো গোপন তথ্য নয়। apiKey ও appId ফাঁকা থাকলে সিঙ্ক নিষ্ক্রিয় থাকে, সাইট শুধু ডিভাইসে চলে।
// গুরুত্বপূর্ণ: নখাপাড়া বিদ্যালয়ের Firebase প্রজেক্টের মান এখানে বসাবেন না — কাশিমনগরের জন্য আলাদা প্রজেক্ট বানান।

export const firebaseConfig = {
  apiKey: "",
  authDomain: "",        // যেমন: kashimnagar-gps.firebaseapp.com
  projectId: "",         // যেমন: kashimnagar-gps
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

export const COLLECTION = "sync";

export const SYNC_KEYS = [
  "lessonPlans",
  "students",
  "kashimnagar_glance_data",
  "kashimnagar_senior_officers",
  "kashimnagar_evaluation",
  "kashimnagar_last_visit_date",
  "kashimnagar_last_visit_officer",
  "kashimnagar_last_visit_desig",
  "kashimnagar_visit_desig_options",
  "kashimnagar_school_geo",
  "kashimnagar_school_radius",
  "kashimnagar_attendance",
  "kashimnagar_social_links",
  "kashimnagar_last_visit_geo",
  "kashimnagar_stu_attendance",
  "kashimnagar_teachers",
  "kashimnagar_teacher_leaves",
  "kashimnagar_school_holidays",
  "kashimnagar_exam_routine",
  "kashimnagar_school_profile",
  "kashimnagar_report_extra"
];
