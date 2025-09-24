CREATE TABLE IF NOT EXISTS user_roles (
  email TEXT PRIMARY KEY,
  roles TEXT NOT NULL -- store JSON array like '["admin","user"]' or CSV 'admin,user'
);

-- Example inserts
INSERT INTO user_roles (email, roles) VALUES ('admin@example.com', '["admin","sme","user"]') ON CONFLICT DO NOTHING;
INSERT INTO user_roles (email, roles) VALUES ('sme@example.com', '["sme","user"]') ON CONFLICT DO NOTHING;
INSERT INTO user_roles (email, roles) VALUES ('user@example.com', '["user"]') ON CONFLICT DO NOTHING;
-- Non-authenticated users will be displayed as 'public'