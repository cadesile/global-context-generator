CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE pad_table_1 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_2 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_3 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_4 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_5 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_6 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_7 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_8 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_9 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_10 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_11 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_12 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_13 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_14 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE pad_table_15 (
  id INTEGER PRIMARY KEY,
  col_a TEXT NOT NULL,
  col_b TEXT NOT NULL,
  col_c TEXT NOT NULL
);
CREATE TABLE zzz_last_table (
  id INTEGER PRIMARY KEY,
  note TEXT NOT NULL
);
