-- Runs once, when the MySQL data volume is first created.
-- The image already created the user from MYSQL_USER / MYSQL_PASSWORD.
-- The app may create and own any database named scalecart_* (one per module, plus
-- scalecart_test_* for the e2e tests) and nothing else on the server.
GRANT ALL PRIVILEGES ON `scalecart\_%`.* TO 'scalecart'@'%';
