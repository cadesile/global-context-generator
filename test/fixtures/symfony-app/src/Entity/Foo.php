<?php
namespace App\Entity;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Foo
{
    #[ORM\Id]
    #[ORM\Column]
    private int $id;

    #[ORM\Column]
    private int $hallOfFamePoints;

    #[ORM\Column]
    private int $reputation;

    #[ORM\Column]
    private int $totalCareerEarnings;
}
