<?php
return new class extends Migration {
    public function up(): void {
        Schema::create('users', function (Blueprint $table) {
            $table->string('name');
            $table->string('email');
            $table->timestamps();
        });
    }
};
