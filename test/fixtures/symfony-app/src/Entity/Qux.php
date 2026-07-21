<?php
namespace App\Entity;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Qux
{
    #[ORM\Id]
    #[ORM\Column]
    private int $id;

    #[ORM\Column(type: 'json')]
    private array $traitMapping;
}
