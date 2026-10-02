CREATE TABLE IF NOT EXISTS products (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120)  NOT NULL,
  description TEXT          NOT NULL,
  price       DECIMAL(10,2) NOT NULL,
  image_key   VARCHAR(255)  NOT NULL COMMENT 'S3 object key, e.g. images/headphones.svg',
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
