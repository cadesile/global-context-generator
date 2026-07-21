<?php
namespace DoctrineMigrations;
final class Version20260301120000 {
    public function up(): void {
        $this->addSql('CREATE TABLE foo (id INT AUTO_INCREMENT NOT NULL) DEFAULT CHARACTER SET utf8mb4');
    }
}
