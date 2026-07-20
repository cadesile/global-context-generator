<?php
class User extends Model {
    protected $fillable = ['name', 'email'];
    protected $casts = ['email_verified_at' => 'datetime'];
    public function tasks() { return $this->hasMany(Task::class); }
}
